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
		`\n=== Lesson 9.4 — Circuit Breaker ===\n` +
			`   billing এর একটা instance · ${REQUESTS} টা "task তৈরি" · ${CONCURRENCY} জন একসাথে\n` +
			`   call এর timeout ${TIMEOUT_MS} ms · billing ধীর হলে প্রতি উত্তরে ${SLOW_MS} ms\n` +
			`   breaker: পরপর ${THRESHOLD} টা ব্যর্থতায় open, ${OPEN_MS} ms পরে half-open এ একটা probe\n`
	);

	const billing = await startBilling('billing-1', PORT, { healthyMs: 3, slowMs: SLOW_MS });

	console.log(
		`── ক. billing ধীর হয়ে গেল (প্রতি উত্তরে ${SLOW_MS} ms, timeout ${TIMEOUT_MS} ms) ──`
	);
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
		`   breaker কতবার খুলেছে: ${breaker.stats().opened} · half-open probe: ${breaker.stats().probes} · fail-fast এ ফেরানো: ${breaker.stats().rejected}\n` +
			`   ধীর billing এ পৌঁছানো call: ${naiveReached} → ${guardedReached} ` +
			`(${pad((((naiveReached - guardedReached) / Math.max(1, naiveReached)) * 100).toFixed(0), 2)}% কম চাপ মরতে থাকা service এর উপর)\n`
	);

	console.log(`── খ. billing সুস্থ হলো — breaker কত দ্রুত টের পায় ──`);
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
		`   billing সুস্থ হওয়ার পর breaker আবার closed হতে লেগেছে: ${recoveredAfter < 0 ? 'হয়নি' : ms(recoveredAfter)}\n` +
			`   (open এর মেয়াদের বাকি অংশ + একটা probe — মেয়াদ শুরু হয়েছিল অংশ ক এ; সবচেয়ে খারাপ ক্ষেত্রে পুরো ${OPEN_MS} ms)\n` +
			`   এই সময়টায় half-open probe গেছে: ${breaker.stats().probes} টা · মোট fail-fast: ${breaker.stats().rejected} টা\n`
	);

	console.log(`── গ. fail-fast এর বদলে fallback (Lesson 9.1 এর "timeout + fallback") ──`);
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
		`\n   fallback মানে user একটা উত্তর পায় (task তৈরি হলো, quota পরে মিলিয়ে নেওয়া হবে) — ` +
			`error না।\n   কোনটা নিরাপদ সেটা ব্যবসার সিদ্ধান্ত, breaker এর না।\n`
	);

	await billing.stop();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
