import { startBilling } from './billing';
import { CircuitBreaker } from './breaker';
import { callService, type CallResult } from './http';
import { ms, pad, padEnd, percentile, sleep } from './random';

const PORT = Number(process.env.PORT ?? 4201);
const REQUESTS = Number(process.env.REQUESTS ?? 400);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 300);
const SLOW_MS = Number(process.env.SLOW_MS ?? 2000);
const THRESHOLD = Number(process.env.THRESHOLD ?? 5);
const OPEN_MS = Number(process.env.OPEN_MS ?? 500);

const LABEL = 26;
const COL = 12;

type RunResult = {
	ok: number;
	failed: number;
	rejected: number;
	reached: number;
	wallMs: number;
	p50: number;
	p99: number;
};

const padLeft = (value: string | number, width: number): string => String(value).padStart(width);

function header(label: string, columns: string[]): string {
	return `   ${padEnd(label, LABEL)}${columns.map((c) => padLeft(c, COL)).join('')}`;
}

function line(label: string, result: RunResult): string {
	const opsPerSecond = Math.round((result.ok + result.failed) / (result.wallMs / 1000));
	return (
		`   ${padEnd(label, LABEL)}` +
		padLeft(result.ok, COL) +
		padLeft(result.failed, COL) +
		padLeft(result.rejected, COL) +
		padLeft(result.reached, COL) +
		padLeft(opsPerSecond, COL) +
		padLeft(ms(result.p50), COL) +
		padLeft(ms(result.p99), COL)
	);
}

async function run(
	requests: number,
	breaker: CircuitBreaker | null,
	fallback: boolean
): Promise<RunResult> {
	const result: RunResult = {
		ok: 0,
		failed: 0,
		rejected: 0,
		reached: 0,
		wallMs: 0,
		p50: 0,
		p99: 0
	};
	const latencies: number[] = [];
	let issued = 0;
	const started = performance.now();

	async function worker(): Promise<void> {
		while (issued < requests) {
			issued += 1;
			const at = performance.now();
			if (breaker && !breaker.allow(at)) {
				latencies.push(performance.now() - at);
				result.rejected += 1;
				if (fallback) result.ok += 1;
				else result.failed += 1;
				continue;
			}
			result.reached += 1;
			const call: CallResult = await callService(
				`http://127.0.0.1:${PORT}/reserve?ws=1`,
				TIMEOUT_MS
			);
			latencies.push(call.ms);
			if (call.outcome === 'ok') {
				result.ok += 1;
				breaker?.onSuccess();
			} else {
				result.failed += 1;
				breaker?.onFailure(performance.now());
			}
		}
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
	result.wallMs = performance.now() - started;
	result.p50 = percentile(latencies, 50);
	result.p99 = percentile(latencies, 99);
	return result;
}

async function main(): Promise<void> {
	console.log(
		`\n=== Lesson 9.4 - Circuit Breaker ===\n` +
			`   one billing instance · ${REQUESTS} "create task" · ${CONCURRENCY} at once\n` +
			`   call timeout ${TIMEOUT_MS} ms · ${SLOW_MS} ms per response when billing is slow\n` +
			`   breaker: open after ${THRESHOLD} failures in a row, one probe in half-open after ${OPEN_MS} ms\n`
	);

	const billing = await startBilling('billing-1', PORT, { healthyMs: 3, slowMs: SLOW_MS });

	console.log(`── a. billing got slow (${SLOW_MS} ms per response, timeout ${TIMEOUT_MS} ms) ──`);
	console.log(header('path', ['ok', 'failed', 'fast-fail', 'reached', 'ops/s', 'p50', 'p99']));

	billing.setMode('slow');

	const before = billing.handled();
	const naive = await run(REQUESTS, null, false);
	const naiveReached = billing.handled() - before;

	const breaker = new CircuitBreaker({
		failureThreshold: THRESHOLD,
		openMs: OPEN_MS,
		successesToClose: 1
	});
	const beforeBreaker = billing.handled();
	const guarded = await run(REQUESTS, breaker, false);
	const guardedReached = billing.handled() - beforeBreaker;

	naive.reached = naiveReached;
	guarded.reached = guardedReached;

	console.log(line('no breaker', naive));
	console.log(line('breaker', guarded));
	console.log('');
	console.log(
		`   times the breaker opened: ${breaker.stats().opened} · half-open probes: ${breaker.stats().probes} · rejected by fail-fast: ${breaker.stats().rejected}\n` +
			`   calls that reached the slow billing: ${naiveReached} → ${guardedReached} ` +
			`(${pad((((naiveReached - guardedReached) / Math.max(1, naiveReached)) * 100).toFixed(0), 2)}% less pressure on the dying service)\n`
	);

	console.log(`── b. billing recovered - how fast the breaker notices ──`);
	billing.setMode('healthy');
	const recoveryStart = performance.now();
	let recoveredAfter = -1;
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const now = performance.now();
		if (breaker.allow(now)) {
			const call = await callService(`http://127.0.0.1:${PORT}/reserve?ws=1`, TIMEOUT_MS);
			if (call.outcome === 'ok') {
				breaker.onSuccess();
				if (breaker.state(performance.now()) === 'closed') {
					recoveredAfter = performance.now() - recoveryStart;
					break;
				}
			} else breaker.onFailure(performance.now());
		}
		await sleep(10);
	}
	console.log(
		`   time for the breaker to close again after billing recovered: ${recoveredAfter < 0 ? 'never' : ms(recoveredAfter)}\n` +
			`   (the rest of the open period + one probe - the period began in part a; in the worst case the full ${OPEN_MS} ms)\n` +
			`   half-open probes sent during this time: ${breaker.stats().probes} · total fail-fast: ${breaker.stats().rejected}\n`
	);

	console.log(`── c. A fallback instead of fail-fast (Lesson 9.1's "timeout + fallback") ──`);
	billing.setMode('slow');
	const withFallback = new CircuitBreaker({
		failureThreshold: THRESHOLD,
		openMs: OPEN_MS,
		successesToClose: 1
	});
	const beforeFallback = billing.handled();
	const fallbackRun = await run(REQUESTS, withFallback, true);
	fallbackRun.reached = billing.handled() - beforeFallback;
	console.log(header('path', ['ok', 'failed', 'fast-fail', 'reached', 'ops/s', 'p50', 'p99']));
	console.log(line('breaker + fallback', fallbackRun));
	console.log(
		`\n   a fallback means the user gets an answer (the task was created, the quota will be reconciled later) - ` +
			`not an error.\n   Which one is safe is a business decision, not the breaker's.\n`
	);

	await billing.stop();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
