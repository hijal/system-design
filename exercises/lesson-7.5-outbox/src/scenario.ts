import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { Op } from 'sequelize';
import { z } from 'zod';
import { Comment, OutboxEvent, sequelize } from './db';
import { commentCreatedSchema, connectRedis, STREAM, waitReady } from './events';

// Lesson 7.5 — তিনটা writer এর তুলনা: কে কী হারায়, কী বানিয়ে ফেলে, কী দুবার পাঠায়।
//
//   npm run scenario                         → তিনটা mode পরপর (MODE=all)
//   MODE=outbox npm run scenario             → একটা
//   REDIS_OUTAGE_MS=3000 WRITE_DELAY_MS=2 …  → চলার মাঝে Redis ৩ সেকেন্ড বন্ধ (docker compose stop/start)
//
// শেষে যাচাই: Postgres এর comment বনাম Redis Stream এর event, comment id ধরে।

const config = z
	.object({
		MODE: z.enum(['commit-first', 'publish-first', 'outbox', 'all']).default('all'),
		N: z.coerce.number().int().positive().default(2000),
		CRASH_RATE: z.coerce.number().min(0).max(1).default(0.02),
		RELAY_CRASH_RATE: z.coerce.number().min(0).max(1).default(0.005),
		POLL_MS: z.coerce.number().int().positive().default(200),
		BATCH: z.coerce.number().int().positive().default(50),
		REDIS_OUTAGE_MS: z.coerce.number().int().nonnegative().default(0),
		WRITE_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
		SEED: z.coerce.number().int().default(7)
	})
	.parse(process.env);

type Mode = 'commit-first' | 'publish-first' | 'outbox';

const writerMessage = z.union([
	z.object({ started: z.number() }),
	z.object({ rejected: z.number() }),
	z.object({ publishFailed: z.number() })
]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (ms: number): string =>
	ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const root = path.join(__dirname, '..');

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function compose(action: 'stop' | 'start'): void {
	spawnSync('docker', ['compose', action, 'redis'], { cwd: root, stdio: 'ignore' });
}

interface Report {
	mode: Mode;
	writerCrashes: number;
	rejected: number;
	publishFailed: number;
	comments: number;
	events: number;
	missing: number;
	ghost: number;
	duplicates: number;
	distinctEventIds: number;
	relayCrashes: number;
	lagP50: number;
	lagP99: number;
	unpublished: number;
}

async function runWriter(mode: Mode, report: Report): Promise<void> {
	let next = 1;
	while (next <= config.N) {
		let last = next - 1;
		const child = fork(path.join(__dirname, 'writer.js'), [], {
			env: {
				...process.env,
				MODE: mode,
				FROM: String(next),
				TO: String(config.N),
				CRASH_RATE: String(config.CRASH_RATE),
				SEED: String(config.SEED),
				WRITE_DELAY_MS: String(config.WRITE_DELAY_MS)
			},
			stdio: ['ignore', 'inherit', 'inherit', 'ipc']
		});
		child.on('message', (raw: unknown) => {
			const m = writerMessage.safeParse(raw);
			if (!m.success) return;
			if ('started' in m.data) last = m.data.started;
			else if ('rejected' in m.data) report.rejected++;
			else report.publishFailed++;
		});
		const signal = await new Promise<NodeJS.Signals | null>((resolve) =>
			child.once('exit', (_code, sig) => resolve(sig))
		);
		if (signal === 'SIGKILL') report.writerCrashes++;
		else if (last < config.N) throw new Error('writer exited unexpectedly');
		// crash করা comment টা বাদ (user error দেখেছে) — পরের id থেকে নতুন writer
		next = last + 1;
	}
}

function startRelay(generation: number): ChildProcess {
	return fork(path.join(__dirname, 'relay.js'), [], {
		env: {
			...process.env,
			POLL_MS: String(config.POLL_MS),
			BATCH: String(config.BATCH),
			CRASH_RATE: String(config.RELAY_CRASH_RATE),
			SEED: String(config.SEED),
			GENERATION: String(generation)
		},
		stdio: ['ignore', 'inherit', 'inherit', 'ipc']
	});
}

async function run(mode: Mode): Promise<Report> {
	await sequelize.sync({ force: true });
	const redis = connectRedis();
	redis.on('error', () => {});
	await waitReady(redis);
	await redis.del(STREAM);

	const report: Report = {
		mode,
		writerCrashes: 0,
		rejected: 0,
		publishFailed: 0,
		comments: 0,
		events: 0,
		missing: 0,
		ghost: 0,
		duplicates: 0,
		distinctEventIds: 0,
		relayCrashes: 0,
		lagP50: 0,
		lagP99: 0,
		unpublished: 0
	};

	// Outbox mode এ relay পুরো সময় চলে; crash করলে নতুন relay (Kubernetes এর restart এর মতো)
	// closure এর ভেতর থেকে বদলায় — তাই একটা holder (TypeScript এর narrowing এর জন্য)
	const relay: { current: ChildProcess | null } = { current: null };
	let generation = 0;
	let stopping = false;
	const keepRelay = (): void => {
		const child = startRelay(generation++);
		relay.current = child;
		child.once('exit', (_code, signal) => {
			if (stopping) return;
			if (signal === 'SIGKILL') report.relayCrashes++;
			keepRelay();
		});
	};
	if (mode === 'outbox') keepRelay();

	const outage =
		config.REDIS_OUTAGE_MS > 0
			? sleep(500).then(async () => {
					compose('stop');
					console.log(`   (Redis বন্ধ, ${fmt(config.REDIS_OUTAGE_MS)})`);
					await sleep(config.REDIS_OUTAGE_MS);
					compose('start');
					console.log('   (Redis আবার চালু)');
				})
			: Promise.resolve();

	await runWriter(mode, report);
	await outage;

	if (mode === 'outbox') {
		for (let waited = 0; waited < 60_000; waited += 200) {
			if ((await OutboxEvent.count({ where: { publishedAt: null } })) === 0) break;
			await sleep(200);
		}
		stopping = true;
		relay.current?.kill('SIGKILL');
		report.unpublished = await OutboxEvent.count({ where: { publishedAt: null } });
		const published = await OutboxEvent.findAll({ where: { publishedAt: { [Op.ne]: null } } });
		const lags = published.flatMap((e) =>
			e.publishedAt ? [e.publishedAt.getTime() - e.createdAt.getTime()] : []
		);
		report.lagP50 = percentile(lags, 50);
		report.lagP99 = percentile(lags, 99);
	}

	// ── যাচাই ─────────────────────────────────────────────────────────────────────────
	for (let i = 0; i < 50 && redis.status !== 'ready'; i++) await sleep(200);
	const comments = new Set((await Comment.findAll({ attributes: ['id'] })).map((c) => c.id));
	const entries = await redis.xrange(STREAM, '-', '+');
	const perComment = new Map<number, number>();
	const eventIds = new Set<string>();
	for (const [, fields] of entries) {
		const data = fields[fields.indexOf('data') + 1];
		if (data === undefined) continue;
		const event = commentCreatedSchema.parse(JSON.parse(data));
		perComment.set(event.commentId, (perComment.get(event.commentId) ?? 0) + 1);
		eventIds.add(event.eventId);
	}
	report.comments = comments.size;
	report.events = entries.length;
	report.distinctEventIds = eventIds.size;
	report.missing = [...comments].filter((id) => !perComment.has(id)).length;
	report.ghost = [...perComment.keys()].filter((id) => !comments.has(id)).length;
	report.duplicates = [...perComment.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);
	redis.disconnect();
	return report;
}

function print(r: Report): void {
	console.log(`\n── mode: ${r.mode} ${'─'.repeat(56 - r.mode.length)}`);
	console.log(
		`   comment এর চেষ্টা: ${config.N} · writer crash: ${r.writerCrashes} · user error দেখল: ${r.rejected}` +
			(r.mode === 'commit-first' ? ` · event পাঠানো ব্যর্থ (শুধু log এ): ${r.publishFailed}` : '')
	);
	console.log(
		`   database এ comment: ${r.comments} · stream এ event: ${r.events} (আলাদা eventId ${r.distinctEventIds})`
	);
	console.log(`   event হারাল (comment আছে, event নেই):      ${r.missing}`);
	console.log(`   ভুতুড়ে event (event আছে, comment নেই):     ${r.ghost}`);
	console.log(`   একই comment এর বাড়তি event:               ${r.duplicates}`);
	if (r.mode === 'outbox')
		console.log(
			`   relay crash: ${r.relayCrashes} · commit থেকে stream এ পৌঁছাতে p50 ${fmt(r.lagP50)}, p99 ${fmt(r.lagP99)} · শেষে না-পাঠানো: ${r.unpublished}`
		);
}

async function main(): Promise<void> {
	try {
		await sequelize.authenticate();
	} catch {
		console.error('Postgres পাওয়া যাচ্ছে না — আগে `docker compose up -d --wait` চালাও।');
		process.exit(1);
	}
	console.log(
		`   CRASH_RATE ${config.CRASH_RATE} (writer), ${config.RELAY_CRASH_RATE} (relay, প্রতি event) · relay: প্রতি ${fmt(config.POLL_MS)} এ খোঁজে, batch ${config.BATCH}${config.REDIS_OUTAGE_MS ? ` · Redis outage ${fmt(config.REDIS_OUTAGE_MS)}` : ''}`
	);
	const modes: Mode[] =
		config.MODE === 'all' ? ['commit-first', 'publish-first', 'outbox'] : [config.MODE];
	const reports: Report[] = [];
	for (const mode of modes) {
		const report = await run(mode);
		print(report);
		reports.push(report);
	}
	if (reports.length > 1) {
		console.log(`\n── তুলনা ${'─'.repeat(58)}`);
		console.log('   mode             comment   হারাল   ভুতুড়ে   বাড়তি (একই eventId)');
		for (const r of reports)
			console.log(
				`   ${r.mode.padEnd(15)}${String(r.comments).padStart(9)}${String(r.missing).padStart(8)}${String(r.ghost).padStart(9)}${String(r.duplicates).padStart(9)}`
			);
	}
	await sequelize.close();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
