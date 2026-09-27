import { z } from 'zod';
import { runLog, runPubSub, runQueue, type LogOptions } from './brokers';
import { Recorder, type Outage, type ServiceReport, type ServiceSpec } from './model';
import { mulberry32, uniform } from './random';
import { Sim } from './sim';
import { generateEvents, type TaskEvent } from './workload';

// Lesson 7.2 — একই TaskFlow ঘটনার ধারা, তিন ধরনের broker, পাঁচটা পরিস্থিতি:
//
//   npm run fanout    — তিনটা service একই ঘটনা চায় (§১.২)
//   npm run crash     — search service ১০ সেকেন্ড বন্ধ (deploy) (§১.৩)
//   npm run slow      — analytics service আসার গতির চেয়ে ধীর (§১.৩)
//   npm run replay    — নতুন service এসে পুরনো সব ঘটনা চায় (§১.৪)
//   npm run ordering  — একই task এর ঘটনা ক্রমে প্রক্রিয়া করতে হবে (§১.৫)
//   npm run all       — সবগুলো
//
// Seed দেওয়া — প্রতিবার হুবহু একই সংখ্যা। SEED env দিয়ে বদলানো যায়।

const scenario = z
	.enum(['fanout', 'crash', 'slow', 'replay', 'ordering', 'all'])
	.parse(process.argv[2] ?? 'all');
const env = z
	.object({
		SEED: z.coerce.number().int().default(7),
		// Experiment এর জন্য: log এর partition সংখ্যা, offset commit এর ব্যবধান, pub/sub এর buffer সীমা
		PARTITIONS: z.coerce.number().int().positive().default(4),
		COMMIT_MS: z.coerce.number().int().positive().default(5000),
		BUFFER_LIMIT: z.coerce.number().int().positive().default(100)
	})
	.parse(process.env);
const seed = env.SEED;

// প্রতিটা (service, ঘটনা) জোড়ার প্রক্রিয়ার সময় সব broker এ একই — তুলনাটা যাতে সৎ থাকে
function perEvent(
	salt: number,
	pick: (random: () => number) => number
): (event: TaskEvent) => number {
	return (event) => Math.round(pick(mulberry32(seed * 1_000_003 + salt * 7919 + event.id)));
}

const email: ServiceSpec = {
	name: 'email',
	workers: 2,
	processMs: perEvent(1, (r) => uniform(r, 40, 80))
};
const search: ServiceSpec = {
	name: 'search',
	workers: 2,
	processMs: perEvent(2, (r) => uniform(r, 10, 30))
};
const analytics: ServiceSpec = {
	name: 'analytics',
	workers: 1,
	processMs: perEvent(3, (r) => uniform(r, 2, 8))
};

const DURATION = 60_000;
const DRAIN = 120_000; // publish থামার পরে সবাইকে শেষ করার সময়

type Broker = 'pubsub' | 'queue' | 'log';

function simulate(run: (sim: Sim, rec: Recorder) => void, until = DURATION + DRAIN): Recorder {
	const sim = new Sim();
	const rec = new Recorder();
	run(sim, rec);
	sim.run(until);
	return rec;
}

function logDefaults(overrides: Partial<LogOptions> = {}): LogOptions {
	return {
		partitions: env.PARTITIONS,
		key: 'task',
		commitIntervalMs: env.COMMIT_MS,
		retentionMs: 7 * 24 * 3600 * 1000,
		outages: [],
		random: mulberry32(seed + 99),
		...overrides
	};
}

function runBroker(
	broker: Broker,
	events: TaskEvent[],
	services: ServiceSpec[],
	outages: Outage[] = [],
	log: Partial<LogOptions> = {}
): Recorder {
	return simulate((sim, rec) => {
		if (broker === 'pubsub')
			runPubSub(sim, events, services, rec, {
				bufferLimit: env.BUFFER_LIMIT,
				reconnectMs: 1000,
				outages
			});
		else if (broker === 'queue')
			runQueue(sim, events, services, rec, { layout: 'per-service', ackDelayMs: 5, outages });
		else
			runLog(
				sim,
				events,
				services.map((s) => ({ service: s, consumers: s.workers })),
				rec,
				logDefaults({ outages, ...log })
			);
	});
}

const fmt = (ms: number): string =>
	ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const pct = (r: ServiceReport): string =>
	`${Math.round((r.received / Math.max(1, r.expected)) * 100)}%`;
const row = (cells: [string, number][]): string =>
	cells.map(([text, width]) => text.padStart(width)).join('');

function header(title: string, note: string): void {
	console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 70 - title.length))}`);
	console.log(`   ${note}\n`);
}

// ── ১. Fanout ─────────────────────────────────────────────────────────────────────────

function fanout(events: TaskEvent[]): void {
	header('fanout', `${events.length} টা ঘটনা; email, search আর analytics — তিনজনেরই সবগুলো দরকার`);
	const services = [email, search, analytics];
	const variants: [string, Recorder][] = [
		[
			'queue — একটাই queue, সবাই মিলে',
			simulate((sim, rec) =>
				runQueue(sim, events, services, rec, { layout: 'shared', ackDelayMs: 5, outages: [] })
			)
		],
		['queue — service প্রতি queue', runBroker('queue', events, services)],
		['pub/sub', runBroker('pubsub', events, services)],
		['log — service প্রতি group', runBroker('log', events, services)]
	];
	console.log('   broker                            email পেল   search পেল   analytics পেল');
	for (const [name, rec] of variants) {
		const [e, s, a] = services.map((svc) => rec.report(svc.name, events));
		if (!e || !s || !a) continue;
		console.log(
			`   ${name.padEnd(32)}${row([
				[pct(e), 10],
				[pct(s), 13],
				[pct(a), 16]
			])}`
		);
	}
}

// ── ২. Crash ──────────────────────────────────────────────────────────────────────────

function crash(events: TaskEvent[]): void {
	const outage: Outage = { service: 'search', from: 20_000, to: 30_000 };
	header('crash', 'search service 20 s থেকে 30 s বন্ধ (deploy); বাকিরা চলছে');
	const services = [email, search, analytics];
	const variants: [string, Recorder][] = [
		['pub/sub', runBroker('pubsub', events, services, [outage])],
		['queue (ack প্রতি message)', runBroker('queue', events, services, [outage])],
		[`log (commit প্রতি ${fmt(env.COMMIT_MS)})`, runBroker('log', events, services, [outage])],
		[
			'log (commit প্রতি 100 ms)',
			runBroker('log', events, services, [outage], { commitIntervalMs: 100 })
		]
	];
	console.log('   broker                          হারাল   দুবার প্রক্রিয়া   দেরি p99    দেরি max');
	for (const [name, rec] of variants) {
		const r = rec.report('search', events);
		console.log(
			`   ${name.padEnd(30)}${row([
				[String(r.lost), 7],
				[String(r.duplicates), 17],
				[fmt(r.p99), 11],
				[fmt(r.max), 11]
			])}`
		);
	}
}

// ── ৩. Slow consumer ──────────────────────────────────────────────────────────────────

function slow(events: TaskEvent[]): void {
	const slowAnalytics: ServiceSpec = {
		...analytics,
		processMs: perEvent(4, (r) => uniform(r, 60, 100))
	};
	const perSecond = (events.length / (DURATION / 1000)).toFixed(1);
	header(
		'slow',
		`analytics এর ১টা worker, প্রতিটা ঘটনায় 60–100 ms (≈12.5/s); ঘটনা আসে ≈${perSecond}/s`
	);
	const services = [email, search, slowAnalytics];
	console.log(
		'   broker     analytics হারাল   জমা (সর্বোচ্চ)   analytics দেরি max   email দেরি p99'
	);
	for (const broker of ['pubsub', 'queue', 'log'] as const) {
		const rec = runBroker(broker, events, services);
		const a = rec.report('analytics', events);
		const e = rec.report('email', events);
		console.log(
			`   ${broker.padEnd(9)}${row([
				[String(a.lost), 17],
				[String(a.backlogPeak), 17],
				[fmt(a.max), 21],
				[fmt(e.p99), 17]
			])}`
		);
	}
	console.log(
		'\n   (log এর "জমা" = consumer lag — log এ আছে কিন্তু analytics এখনো পড়েনি; broker এর জন্য বাড়তি কিছু না)'
	);
}

// ── ৪. Replay ─────────────────────────────────────────────────────────────────────────

function replay(): void {
	const JOIN = 60_000;
	const events = generateEvents(mulberry32(seed), 90_000, 4);
	const before = events.filter((e) => e.publishedAt < JOIN);
	const after = events.filter((e) => e.publishedAt >= JOIN);
	const searchV2: ServiceSpec = { ...search, name: 'search-v2' };
	header(
		'replay',
		`নতুন search-v2 যোগ দিল 60 s এ; পুরো index বানাতে সব ঘটনা চায় (আগের ${before.length}, পরের ${after.length})`
	);
	const variants: [string, Recorder][] = [
		[
			'pub/sub',
			simulate((sim, rec) =>
				runPubSub(sim, events, [searchV2], rec, {
					bufferLimit: env.BUFFER_LIMIT,
					reconnectMs: 1000,
					outages: [],
					joinAt: { 'search-v2': JOIN }
				})
			)
		],
		[
			'queue',
			simulate((sim, rec) =>
				runQueue(sim, events, [searchV2], rec, {
					layout: 'per-service',
					ackDelayMs: 5,
					outages: [],
					joinAt: { 'search-v2': JOIN }
				})
			)
		],
		...(
			[
				['log (retention 7 দিন)', 7 * 24 * 3600 * 1000],
				['log (retention 30 s)', 30_000]
			] as const
		).map(([name, retentionMs]): [string, Recorder] => [
			name,
			simulate((sim, rec) =>
				runLog(
					sim,
					events,
					[{ service: searchV2, consumers: 2, joinAt: JOIN }],
					rec,
					logDefaults({ retentionMs })
				)
			)
		])
	];
	console.log('   broker                   আগের ঘটনা পেল    পরের ঘটনা পেল');
	for (const [name, rec] of variants) {
		const b = rec.report('search-v2', before);
		const a = rec.report('search-v2', after);
		console.log(
			`   ${name.padEnd(23)}${row([
				[`${b.received} / ${b.expected}`, 15],
				[`${a.received} / ${a.expected}`, 17]
			])}`
		);
	}
}

// ── ৫. Ordering ───────────────────────────────────────────────────────────────────────

function ordering(events: TaskEvent[]): void {
	// প্রতিটা ঘটনায় 20–120 ms, কিন্তু ১% এ 3 s (provider এর একটা ধীর মুহূর্ত)
	const notifier = (workers: number): ServiceSpec => ({
		name: 'notifier',
		workers,
		processMs: perEvent(5, (r) => (r() < 0.01 ? 3000 : uniform(r, 20, 120)))
	});
	const tasks = new Set(events.map((e) => e.taskId)).size;
	header(
		'ordering',
		`notifier service, ${tasks} টা task — একই task এর ঘটনা ক্রমে প্রক্রিয়া হওয়ার কথা`
	);
	const variants: [string, Recorder, string][] = [
		[
			'queue, 4 worker',
			simulate((sim, rec) =>
				runQueue(sim, events, [notifier(4)], rec, {
					layout: 'per-service',
					ackDelayMs: 5,
					outages: []
				})
			),
			'4'
		],
		[
			`log, key = task, ${env.PARTITIONS} partition`,
			simulate((sim, rec) =>
				runLog(sim, events, [{ service: notifier(4), consumers: 4 }], rec, logDefaults())
			),
			String(Math.min(4, env.PARTITIONS))
		],
		[
			`log, key = random, ${env.PARTITIONS} partition`,
			simulate((sim, rec) =>
				runLog(
					sim,
					events,
					[{ service: notifier(4), consumers: 4 }],
					rec,
					logDefaults({ key: 'random' })
				)
			),
			String(Math.min(4, env.PARTITIONS))
		],
		[
			'log, key = task, 8 consumer',
			simulate((sim, rec) =>
				runLog(sim, events, [{ service: notifier(8), consumers: 8 }], rec, logDefaults())
			),
			env.PARTITIONS >= 8 ? '8' : `${env.PARTITIONS} (${8 - env.PARTITIONS} জন বসে থাকে)`
		]
	];
	console.log(
		'   broker                           ক্রম ভাঙা task   দেরি p50   দেরি p99   দেরি max   কাজ পাওয়া consumer'
	);
	for (const [name, rec, busy] of variants) {
		const r = rec.report('notifier', events);
		console.log(
			`   ${name.padEnd(31)}${row([
				[String(r.disorderedTasks), 15],
				[fmt(r.p50), 11],
				[fmt(r.p99), 11],
				[fmt(r.max), 11]
			])}   ${busy}`
		);
	}
}

function main(): void {
	const events = generateEvents(mulberry32(seed), DURATION, 4);
	if (scenario === 'fanout' || scenario === 'all') fanout(events);
	if (scenario === 'crash' || scenario === 'all') crash(events);
	if (scenario === 'slow' || scenario === 'all') slow(events);
	if (scenario === 'replay' || scenario === 'all') replay();
	if (scenario === 'ordering' || scenario === 'all') ordering(events);
}

main();
