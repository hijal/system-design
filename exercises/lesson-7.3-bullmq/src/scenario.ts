import { Queue } from 'bullmq';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { assignJobId, QUEUE_NAME, redisAddress, type AssignEmail } from './config';

// Lesson 7.3 — আসল Redis (Docker) এর উপর আসল BullMQ, আর তিন ধরনের Node process:
// নকল email provider, TaskFlow API (producer), এক বা একাধিক worker (consumer)।
//
// Lesson 7.1 এর মতোই তিনটা phase: provider স্বাভাবিক (150 ms) → ধীর → আবার স্বাভাবিক, আর পুরো
// সময় প্রতি সেকেন্ডে ASSIGN_RPS টা assign। CRASH দিয়ে ধীর phase এর মাঝখানে কোনো process মারা যায়:
//
//   CRASH=api          — API process SIGKILL, সাথে সাথে নতুন API     (7.1 এর experiment ২ আবার)
//   CRASH=worker-kill  — একটা worker SIGKILL, সাথে সাথে নতুন worker  (চলমান job এর কী হয়?)
//   CRASH=worker-term  — একটা worker SIGTERM (graceful), নতুন worker  (deploy যেমন হওয়া উচিত)

const config = z
	.object({
		PHASE_MS: z.coerce.number().int().positive().default(8000),
		SLOW_LATENCY_MS: z.coerce.number().int().nonnegative().default(2000),
		ASSIGN_RPS: z.coerce.number().positive().default(20),
		CRASH: z.enum(['none', 'api', 'worker-kill', 'worker-term']).default('none'),
		CRASH_AT_MS: z.coerce.number().int().positive().default(12_000),
		FAIL_RATE: z.coerce.number().min(0).max(1).default(0),
		ATTEMPTS: z.coerce.number().int().positive().default(5),
		WORKER_PROCS: z.coerce.number().int().positive().default(1),
		CONCURRENCY: z.coerce.number().int().positive().default(8),
		// Production default 30 s / 30 s; scenario ছোট রাখতে কমানো (README এর সৎ নোট দেখো)
		LOCK_MS: z.coerce.number().int().positive().default(10_000),
		STALLED_MS: z.coerce.number().int().positive().default(5000),
		// প্রতিটা assign দুবার পাঠানো — double click বা timeout এর পরে client এর retry এর মতো
		DOUBLE_SUBMIT: z.enum(['0', '1']).default('0')
	})
	.parse(process.env);

const NORMAL_LATENCY_MS = 150;
const CLIENT_TIMEOUT_MS = 5000;

const readySchema = z.object({ ready: z.literal(true), port: z.number().int().nonnegative() });
const providerStatsSchema = z.object({
	deliveries: z.record(z.string(), z.number()),
	rejected: z.number()
});

type Sample = { start: number; ms: number; ok: boolean };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (ms: number): string =>
	ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function start(
	file: string,
	env: Record<string, string>
): Promise<{ child: ChildProcess; url: string }> {
	const child = fork(path.join(__dirname, file), [], {
		env: { ...process.env, ...env },
		stdio: ['ignore', 'inherit', 'inherit', 'ipc']
	});
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code) => reject(new Error(`${file} exited early (code ${code})`)));
		child.once('message', (message: unknown) => {
			const parsed = readySchema.safeParse(message);
			if (!parsed.success) return reject(new Error(`${file}: unexpected message`));
			child.removeAllListeners('exit');
			resolve({ child, url: `http://127.0.0.1:${parsed.data.port}` });
		});
	});
}

async function main(): Promise<void> {
	// Scenario নিজে worker না — Redis না থাকলে অনন্ত অপেক্ষার বদলে দ্রুত ব্যর্থ হোক
	const queue = new Queue(QUEUE_NAME, { connection: { ...redisAddress, maxRetriesPerRequest: 1 } });
	try {
		await queue.waitUntilReady();
		// আগের run এর job মুছে পরিষ্কার শুরু
		await queue.obliterate({ force: true });
	} catch (error: unknown) {
		console.error('Redis পাওয়া যাচ্ছে না — আগে `docker compose up -d --wait` চালাও।');
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}

	const provider = await start('provider.js', {
		LATENCY_MS: String(NORMAL_LATENCY_MS),
		FAIL_RATE: String(config.FAIL_RATE)
	});
	const apiEnv = { ATTEMPTS: String(config.ATTEMPTS) };
	const workerEnv = {
		PROVIDER_URL: provider.url,
		CONCURRENCY: String(config.CONCURRENCY),
		LOCK_MS: String(config.LOCK_MS),
		STALLED_MS: String(config.STALLED_MS)
	};
	let api = await start('api.js', apiEnv);
	const workers: ChildProcess[] = [];
	for (let i = 0; i < config.WORKER_PROCS; i++)
		workers.push((await start('worker.js', workerEnv)).child);

	const setLatency = (latencyMs: number): Promise<Response> =>
		fetch(`${provider.url}/admin/mode`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ latencyMs })
		});

	const t0 = Date.now();
	const log = (text: string): void =>
		console.log(`   ${fmt(Date.now() - t0).padStart(7)}  ${text}`);
	const samples: Sample[] = [];
	const accepted = new Set<string>();
	const inFlight = new Set<Promise<void>>();
	let nextTaskId = 1;
	let peakWaiting = 0;
	let peakDelayed = 0;

	function submit(job: AssignEmail): void {
		const startedAt = Date.now();
		const done = fetch(`${api.url}/api/tasks/${job.taskId}/assign`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ assigneeId: job.assigneeId, assigneeEmail: job.to }),
			signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS)
		})
			.then(async (res) => {
				await res.arrayBuffer();
				if (res.status === 202) accepted.add(assignJobId(job));
				return res.status === 202;
			})
			.catch(() => false)
			.then((ok) => {
				samples.push({ start: startedAt - t0, ms: Date.now() - startedAt, ok });
			});
		inFlight.add(done);
		void done.finally(() => inFlight.delete(done));
	}

	const load = setInterval(() => {
		const taskId = nextTaskId++;
		const job: AssignEmail = {
			taskId,
			assigneeId: (taskId % 50) + 1,
			to: `user${taskId}@taskflow.test`
		};
		submit(job);
		if (config.DOUBLE_SUBMIT === '1') submit(job);
	}, 1000 / config.ASSIGN_RPS);

	const sampler = setInterval(() => {
		queue
			.getJobCounts('waiting', 'delayed')
			.then((c) => {
				peakWaiting = Math.max(peakWaiting, c['waiting'] ?? 0);
				peakDelayed = Math.max(peakDelayed, c['delayed'] ?? 0);
			})
			.catch(() => {});
	}, 250);

	console.log(
		`   load: প্রতি সেকেন্ডে ${config.ASSIGN_RPS} assign · worker process ${config.WORKER_PROCS} × concurrency ${config.CONCURRENCY} · CRASH=${config.CRASH}${config.FAIL_RATE ? ` · FAIL_RATE=${config.FAIL_RATE}` : ''}${config.DOUBLE_SUBMIT === '1' ? ' · DOUBLE_SUBMIT' : ''}\n`
	);
	log(`provider স্বাভাবিক (${NORMAL_LATENCY_MS} ms)`);

	const events: Promise<void>[] = [
		sleep(config.PHASE_MS)
			.then(() => setLatency(config.SLOW_LATENCY_MS))
			.then(() => log(`provider ধীর হলো (${fmt(config.SLOW_LATENCY_MS)} প্রতি email)`)),
		sleep(2 * config.PHASE_MS)
			.then(() => setLatency(NORMAL_LATENCY_MS))
			.then(() => log('provider আবার স্বাভাবিক'))
	];
	if (config.CRASH !== 'none') {
		events.push(
			sleep(config.CRASH_AT_MS).then(async () => {
				if (config.CRASH === 'api') {
					api.child.kill('SIGKILL');
					log('API process SIGKILL — নতুন API চালু হচ্ছে');
					api = await start('api.js', apiEnv);
					return;
				}
				const victim = workers.shift();
				if (!victim) return;
				const counts = await queue.getJobCounts('active');
				victim.kill(config.CRASH === 'worker-kill' ? 'SIGKILL' : 'SIGTERM');
				log(
					`worker ${config.CRASH === 'worker-kill' ? 'SIGKILL' : 'SIGTERM'} (queue এ তখন active: ${counts['active'] ?? 0}) — নতুন worker চালু হচ্ছে`
				);
				workers.push((await start('worker.js', workerEnv)).child);
			})
		);
	}
	await Promise.all(events);
	await sleep(config.PHASE_MS);
	clearInterval(load);
	log('load বন্ধ — queue খালি হওয়ার অপেক্ষা');
	await Promise.all([...inFlight]);

	for (let waited = 0; waited < 120_000; waited += 500) {
		const c = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
		if (Object.values(c).every((n) => n === 0)) break;
		await sleep(500);
	}
	log('queue খালি');
	clearInterval(sampler);

	const stats = providerStatsSchema.parse(
		await (await fetch(`${provider.url}/admin/stats`)).json()
	);
	const completed = await queue.getJobs(['completed'], 0, -1);
	const failedJobs = await queue.getJobs(['failed'], 0, -1);
	const counts = await queue.getJobCounts('completed', 'failed');
	for (const child of [provider.child, api.child, ...workers]) child.kill('SIGTERM');
	await queue.close();

	// ── report ────────────────────────────────────────────────────────────────────────
	const phases = [
		{ name: 'স্বাভাবিক', from: 0, to: config.PHASE_MS },
		{ name: 'provider ধীর', from: config.PHASE_MS, to: 2 * config.PHASE_MS },
		{ name: 'সেরে ওঠার পর', from: 2 * config.PHASE_MS, to: 3 * config.PHASE_MS }
	];
	console.log('\n   phase            API p50 / p99     API ব্যর্থ');
	for (const phase of phases) {
		const xs = samples.filter((s) => s.start >= phase.from && s.start < phase.to);
		const ms = xs.map((s) => s.ms);
		const failed = xs.filter((s) => !s.ok).length;
		console.log(
			`   ${phase.name.padEnd(15)}  ${fmt(percentile(ms, 50)).padStart(7)} / ${fmt(percentile(ms, 99)).padEnd(7)}  ${String(failed).padStart(9)}`
		);
	}

	const delivered = Object.entries(stats.deliveries);
	const duplicates = delivered.filter(([, n]) => n > 1).length;
	const lost = [...accepted].filter((id) => !(id in stats.deliveries)).length;
	const delays = completed.flatMap((j) => (j.finishedOn ? [j.finishedOn - j.timestamp] : []));
	const attempts = new Map<number, number>();
	for (const j of completed) attempts.set(j.attemptsMade, (attempts.get(j.attemptsMade) ?? 0) + 1);

	console.log('');
	console.log(
		`   API 202 দিয়েছে: ${samples.filter((s) => s.ok).length} বার, আলাদা job: ${accepted.size}`
	);
	console.log(
		`   queue এ সর্বোচ্চ: waiting ${peakWaiting}, delayed (retry এর অপেক্ষায়) ${peakDelayed}`
	);
	console.log(
		`   job: completed ${counts['completed'] ?? 0}, failed ${counts['failed'] ?? 0}` +
			`   · চেষ্টা লেগেছে: ${[...attempts.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([n, c]) => `${n} বার → ${c}`)
				.join(', ')}`
	);
	console.log(
		`   provider: আলাদা email পৌঁছেছে ${delivered.length}, 503 দিয়েছে ${stats.rejected} বার`
	);
	console.log(
		`   email পৌঁছাতে (job যোগ থেকে): p50 ${fmt(percentile(delays, 50))}, p99 ${fmt(percentile(delays, 99))}, max ${fmt(Math.max(0, ...delays))}`
	);
	const reasons = new Map<string, number>();
	for (const j of failedJobs) reasons.set(j.failedReason, (reasons.get(j.failedReason) ?? 0) + 1);
	for (const [reason, n] of reasons) console.log(`   failed এর কারণ: "${reason}" × ${n}`);
	console.log(`   "202 পেল, email যায়নি": ${lost}`);
	console.log(`   একই email দুবার (বা বেশি) পৌঁছেছে: ${duplicates}`);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
