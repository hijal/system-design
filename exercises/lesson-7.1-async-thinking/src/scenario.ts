import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { modes, type Mode } from './modes';

// Lesson 7.1 - three real Node processes: the email provider, the TaskFlow API, and this load generator.
//
//   npm run scenario -- sync-in-tx     → one mode
//   npm run compare                    → all four modes in turn, with a comparison at the end
//
// Every run has three phases: provider normal (150 ms) → slow (SLOW_LATENCY_MS) → normal again.
// The same load the whole time: ASSIGN_RPS assigns (with email) and LIST_RPS task lists every second.
// Like a browser/Nginx, the client gives up after CLIENT_TIMEOUT_MS.
//
// With CRASH_AT_MS set, the API process is SIGKILLed at that moment and started again -
// imitating a deploy or crash (experiment 2 in the README).

const config = z
	.object({
		PHASE_MS: z.coerce.number().int().positive().default(8000),
		SLOW_LATENCY_MS: z.coerce.number().int().nonnegative().default(4000),
		ASSIGN_RPS: z.coerce.number().positive().default(20),
		LIST_RPS: z.coerce.number().positive().default(50),
		POOL_MAX: z.coerce.number().int().positive().default(10),
		CLIENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
		CRASH_AT_MS: z.coerce.number().int().positive().optional()
	})
	.parse(process.env);

const target = z.enum([...modes, 'all']).parse(process.argv[2] ?? 'all');

const NORMAL_LATENCY_MS = 150;

type Outcome = 'ok' | 'pool' | 'timeout' | 'error';
type Sample = {
	route: 'assign' | 'list';
	taskId: number;
	start: number;
	ms: number;
	outcome: Outcome;
};

const readySchema = z.object({ ready: z.literal(true), port: z.number().int().positive() });
const apiStatsSchema = z.object({
	pool: z.object({ max: z.number(), busy: z.number(), waiting: z.number() }),
	queue: z.object({ waiting: z.number(), active: z.number() }),
	pendingEmails: z.number(),
	peakPendingEmails: z.number(),
	failedEmails: z.number(),
	emailDelaysMs: z.array(z.number())
});
type ApiStats = z.infer<typeof apiStatsSchema>;
const providerStatsSchema = z.object({
	deliveredTaskIds: z.array(z.number()),
	peakInFlight: z.number(),
	rateLimited: z.number()
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
		child.once('message', (message: unknown) => {
			const parsed = readySchema.safeParse(message);
			if (!parsed.success) return reject(new Error(`${file}: unexpected message`));
			resolve({ child, url: `http://127.0.0.1:${parsed.data.port}` });
		});
	});
}

async function getJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
	const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
	return schema.parse(await res.json());
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const fmtMs = (ms: number): string =>
	ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const pct = (part: number, whole: number): string =>
	whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;

type Result = {
	mode: Mode;
	samples: Sample[];
	peakPoolWaiting: number;
	peakPending: number;
	stats: ApiStats;
	delivered: Set<number>;
	providerPeakInFlight: number;
	rateLimited: number;
};

async function run(mode: Mode): Promise<Result> {
	const provider = await start('provider.js', { LATENCY_MS: String(NORMAL_LATENCY_MS) });
	const apiEnv = { MODE: mode, PROVIDER_URL: provider.url, POOL_MAX: String(config.POOL_MAX) };
	let api = await start('api.js', apiEnv);
	const setLatency = (latencyMs: number): Promise<Response> =>
		fetch(`${provider.url}/admin/mode`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ latencyMs })
		});

	const t0 = Date.now();
	const samples: Sample[] = [];
	const inFlight = new Set<Promise<void>>();
	let nextTaskId = 1;
	let peakPoolWaiting = 0;
	let peakPending = 0;
	let crashed = false;

	function fire(route: Sample['route']): void {
		const taskId = route === 'assign' ? nextTaskId++ : 0;
		const startedAt = Date.now();
		const request =
			route === 'assign'
				? fetch(`${api.url}/api/tasks/${taskId}/assign`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ assigneeEmail: `user${taskId}@taskflow.test` }),
						signal: AbortSignal.timeout(config.CLIENT_TIMEOUT_MS)
					})
				: fetch(`${api.url}/api/tasks`, { signal: AbortSignal.timeout(config.CLIENT_TIMEOUT_MS) });
		const done = request
			.then(async (res): Promise<Outcome> => {
				await res.arrayBuffer();
				return res.ok ? 'ok' : res.status === 503 ? 'pool' : 'error';
			})
			.catch((error: unknown): Outcome =>
				error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'error'
			)
			.then((outcome) => {
				samples.push({ route, taskId, start: startedAt - t0, ms: Date.now() - startedAt, outcome });
			});
		inFlight.add(done);
		void done.finally(() => inFlight.delete(done));
	}

	const assignTimer = setInterval(() => fire('assign'), 1000 / config.ASSIGN_RPS);
	const listTimer = setInterval(() => fire('list'), 1000 / config.LIST_RPS);
	const sampler = setInterval(() => {
		getJson(`${api.url}/internal/stats`, apiStatsSchema)
			.then((s) => {
				peakPoolWaiting = Math.max(peakPoolWaiting, s.pool.waiting);
				peakPending = Math.max(peakPending, s.pendingEmails);
			})
			.catch(() => {});
	}, 250);

	const phaseLog = (text: string): void =>
		console.log(`   ${fmtMs(Date.now() - t0).padStart(7)}  ${text}`);

	console.log(`\n── mode: ${mode} ${'─'.repeat(50 - mode.length)}`);
	phaseLog(`provider normal (${NORMAL_LATENCY_MS} ms)`);

	const events: Promise<void>[] = [
		sleep(config.PHASE_MS)
			.then(() => setLatency(config.SLOW_LATENCY_MS))
			.then(() => phaseLog(`provider slowed down (${fmtMs(config.SLOW_LATENCY_MS)} per email)`)),
		sleep(2 * config.PHASE_MS)
			.then(() => setLatency(NORMAL_LATENCY_MS))
			.then(() => phaseLog('provider normal again'))
	];
	if (config.CRASH_AT_MS !== undefined) {
		events.push(
			sleep(config.CRASH_AT_MS).then(async () => {
				crashed = true;
				api.child.kill('SIGKILL');
				phaseLog('API process SIGKILL - deploy/crash; starting a new process');
				api = await start('api.js', apiEnv);
			})
		);
	}
	await Promise.all(events);
	await sleep(config.PHASE_MS);
	clearInterval(assignTimer);
	clearInterval(listTimer);
	phaseLog('load stopped - waiting for the remaining requests and emails to finish');
	await Promise.all([...inFlight]);

	// let the emails still queued or in flight finish (at most 30 seconds)
	let stats = await getJson(`${api.url}/internal/stats`, apiStatsSchema);
	for (let waited = 0; stats.pendingEmails > 0 && waited < 30_000; waited += 250) {
		await sleep(250);
		stats = await getJson(`${api.url}/internal/stats`, apiStatsSchema);
	}
	clearInterval(sampler);
	const providerStats = await getJson(`${provider.url}/admin/stats`, providerStatsSchema);
	api.child.kill();
	provider.child.kill();
	if (crashed)
		phaseLog("(email timing counts only the new process - the old one's memory is gone)");

	return {
		mode,
		samples,
		peakPoolWaiting: Math.max(peakPoolWaiting, stats.pool.waiting),
		peakPending: Math.max(peakPending, stats.peakPendingEmails),
		stats,
		delivered: new Set(providerStats.deliveredTaskIds),
		providerPeakInFlight: providerStats.peakInFlight,
		rateLimited: providerStats.rateLimited
	};
}

function phaseTable(result: Result): void {
	const phases = [
		{ name: 'normal', from: 0, to: config.PHASE_MS },
		{ name: 'provider slow', from: config.PHASE_MS, to: 2 * config.PHASE_MS },
		{ name: 'after recovery', from: 2 * config.PHASE_MS, to: 3 * config.PHASE_MS }
	];
	console.log('');
	console.log('   phase            assign p50 / p99   assign failed    list p99   list failed');
	for (const phase of phases) {
		const inPhase = result.samples.filter((s) => s.start >= phase.from && s.start < phase.to);
		const assign = inPhase.filter((s) => s.route === 'assign');
		const list = inPhase.filter((s) => s.route === 'list');
		const failed = (xs: Sample[]): number => xs.filter((s) => s.outcome !== 'ok').length;
		console.log(
			`   ${phase.name.padEnd(15)}  ${fmtMs(
				percentile(
					assign.map((s) => s.ms),
					50
				)
			).padStart(7)} / ${fmtMs(
				percentile(
					assign.map((s) => s.ms),
					99
				)
			).padEnd(7)}  ${pct(failed(assign), assign.length).padStart(13)}    ${fmtMs(
				percentile(
					list.map((s) => s.ms),
					99
				)
			).padStart(8)}   ${pct(failed(list), list.length).padStart(11)}`
		);
	}
}

type Summary = {
	assignOk: number;
	assignFailed: number;
	listFailed: number;
	listTotal: number;
	lost: number;
	unknown: number;
	emailP99: number;
};

function summarize(result: Result): Summary {
	const assign = result.samples.filter((s) => s.route === 'assign');
	const list = result.samples.filter((s) => s.route === 'list');
	const ok = assign.filter((s) => s.outcome === 'ok');
	const failed = assign.filter((s) => s.outcome !== 'ok');
	return {
		assignOk: ok.length,
		assignFailed: failed.length,
		listFailed: list.filter((s) => s.outcome !== 'ok').length,
		listTotal: list.length,
		// the user was told "done", but the email never arrived
		lost: ok.filter((s) => !result.delivered.has(s.taskId)).length,
		// the user was told "failed", yet both the assign and the email happened - the "don't know" of Lesson 6.1
		unknown: failed.filter((s) => result.delivered.has(s.taskId)).length,
		emailP99: percentile(result.stats.emailDelaysMs, 99)
	};
}

function report(result: Result): Summary {
	phaseTable(result);
	const s = summarize(result);
	const failures = result.samples.filter((x) => x.route === 'assign' && x.outcome !== 'ok');
	const count = (o: Outcome): number => failures.filter((x) => x.outcome === o).length;
	console.log('');
	console.log(
		`   assign: ok ${s.assignOk}, failed ${s.assignFailed}  (pool exhausted ${count('pool')}, client timeout ${count('timeout')}, other ${count('error')})`
	);
	console.log(
		`   list:   failed ${s.listFailed} / ${s.listTotal}   ← this route never touches email`
	);
	console.log(
		`   max pool queue: ${result.peakPoolWaiting}   emails pending (max): ${result.peakPending}   max concurrent at provider: ${result.providerPeakInFlight}`
	);
	console.log(
		`   provider returned 429 (rate limited): ${result.rateLimited}   email delivery (from assign) p99: ${fmtMs(s.emailP99)}`
	);
	console.log(`   told "ok", email never sent: ${s.lost}`);
	console.log(`   told "failed", yet email sent: ${s.unknown}`);
	return s;
}

async function main(): Promise<void> {
	console.log(
		`   load: ${config.ASSIGN_RPS} assign + ${config.LIST_RPS} list per second · pool max ${config.POOL_MAX} · client timeout ${fmtMs(config.CLIENT_TIMEOUT_MS)}`
	);
	const targets: Mode[] = target === 'all' ? [...modes] : [target];
	const summaries: [Mode, Summary][] = [];
	for (const mode of targets) summaries.push([mode, report(await run(mode))]);
	if (summaries.length < 2) return;
	console.log('\n── comparison ' + '─'.repeat(46));
	console.log('   mode              assign failed  list failed   email p99     said ok, no email');
	for (const [mode, s] of summaries) {
		console.log(
			`   ${mode.padEnd(18)}  ${String(s.assignFailed).padStart(11)}   ${String(s.listFailed).padStart(10)}   ${fmtMs(s.emailP99).padStart(9)}   ${String(s.lost).padStart(19)}`
		);
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
