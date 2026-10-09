import {
	FixedWindowCounter,
	SlidingWindowCounter,
	SlidingWindowLog,
	type RateLimiter
} from './limiters';
import { padEnd, padLeft } from './random';

const LIMIT = Number(process.env.LIMIT ?? 10);
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 1000);
const SWEEP_MS = Number(process.env.SWEEP_MS ?? 5000);
const STEP_MS = Number(process.env.STEP_MS ?? 10);
const USERS = Number(process.env.USERS ?? 50000);

const LABEL = 20;
const COL = 14;

function build(): RateLimiter[] {
	return [
		new FixedWindowCounter(LIMIT, WINDOW_MS),
		new SlidingWindowLog(LIMIT, WINDOW_MS),
		new SlidingWindowCounter(LIMIT, WINDOW_MS)
	];
}

function runGc(): void {
	const g: unknown = Reflect.get(globalThis, 'gc');
	if (typeof g === 'function') g();
}

function maxInAnyWindow(allowedAt: number[], windowMs: number): number {
	let best = 0;
	let start = 0;
	for (let end = 0; end < allowedAt.length; end += 1) {
		while ((allowedAt[end] ?? 0) - (allowedAt[start] ?? 0) >= windowMs) start += 1;
		best = Math.max(best, end - start + 1);
	}
	return best;
}

function boundaryBurst(limiter: RateLimiter): { allowed: number; spanMs: number } {
	limiter.reset();
	const times: number[] = [];
	for (let i = 0; i < LIMIT; i += 1) times.push(WINDOW_MS - LIMIT - 5 + i);
	for (let i = 0; i < LIMIT; i += 1) times.push(WINDOW_MS + i);
	let allowed = 0;
	const allowedTimes: number[] = [];
	for (const at of times) {
		const decision = limiter.check('user-1', at);
		if (decision.allowed) {
			allowed += 1;
			allowedTimes.push(at);
		}
	}
	const first = allowedTimes[0] ?? 0;
	const last = allowedTimes[allowedTimes.length - 1] ?? 0;
	return { allowed, spanMs: last - first };
}

function sweepFrom(limiter: RateLimiter, offset: number): { allowed: number; worst: number } {
	limiter.reset();
	const allowedAt: number[] = [];
	for (let at = offset; at <= offset + SWEEP_MS; at += STEP_MS)
		if (limiter.check('user-1', at).allowed) allowedAt.push(at);
	return { allowed: allowedAt.length, worst: maxInAnyWindow(allowedAt, WINDOW_MS) };
}

function worstOverAllPhases(make: () => RateLimiter): { worst: number; atOffset: number } {
	let worst = 0;
	let atOffset = 0;
	for (let offset = 0; offset < WINDOW_MS; offset += STEP_MS) {
		const result = sweepFrom(make(), offset);
		if (result.worst > worst) {
			worst = result.worst;
			atOffset = offset;
		}
	}
	return { worst, atOffset };
}

function memory(make: () => RateLimiter): { bytesPerUser: number; entries: number } {
	runGc();
	const before = process.memoryUsage().heapUsed;
	const limiter = make();
	for (let user = 0; user < USERS; user += 1) {
		const key = `ws-42:user-${user}`;
		for (let i = 0; i < LIMIT; i += 1) limiter.check(key, i * 10);
	}
	runGc();
	const after = process.memoryUsage().heapUsed;
	const entries = limiter.entries();
	return { bytesPerUser: (after - before) / USERS, entries };
}

function main(): void {
	console.log(
		`\n=== Lesson 9.5 - Window Algorithms ===\n` +
			`   limit: ${LIMIT} requests per ${WINDOW_MS} ms · one user\n`
	);

	console.log(
		`── a. A burst at the window boundary - ${LIMIT} just before, ${LIMIT} just after ──`
	);
	console.log(
		`   ${padEnd('algorithm', LABEL)}${padLeft('allowed', COL)}${padLeft('span', COL)}${padLeft('times the limit', COL + 4)}`
	);
	for (const limiter of build()) {
		const result = boundaryBurst(limiter);
		console.log(
			`   ${padEnd(limiter.name, LABEL)}${padLeft(result.allowed, COL)}${padLeft(`${result.spanMs} ms`, COL)}` +
				padLeft(`${(result.allowed / LIMIT).toFixed(1)}x`, COL + 4)
		);
	}

	console.log(
		`\n── b. The most one user can send - an attempt every ${STEP_MS} ms, the worst over every start time ──`
	);
	console.log(
		`   ${padEnd('algorithm', LABEL)}${padLeft(`worst / ${WINDOW_MS} ms`, COL + 4)}${padLeft('times the limit', COL + 4)}${padLeft('at phase', COL + 4)}`
	);
	const phaseMakers: Array<[string, () => RateLimiter]> = [
		['fixed window', () => new FixedWindowCounter(LIMIT, WINDOW_MS)],
		['sliding log', () => new SlidingWindowLog(LIMIT, WINDOW_MS)],
		['sliding counter', () => new SlidingWindowCounter(LIMIT, WINDOW_MS)]
	];
	for (const [name, make] of phaseMakers) {
		const result = worstOverAllPhases(make);
		console.log(
			`   ${padEnd(name, LABEL)}${padLeft(result.worst, COL + 4)}` +
				padLeft(`${(result.worst / LIMIT).toFixed(1)}x`, COL + 4) +
				padLeft(`${result.atOffset} ms`, COL + 4)
		);
	}

	console.log(`\n── c. Memory - ${USERS.toLocaleString('en-US')} users, ${LIMIT} requests each ──`);
	console.log(
		`   ${padEnd('algorithm', LABEL)}${padLeft('entries', COL)}${padLeft('bytes/user', COL)}`
	);
	const makers: Array<[string, () => RateLimiter]> = [
		['fixed window', () => new FixedWindowCounter(LIMIT, WINDOW_MS)],
		['sliding log', () => new SlidingWindowLog(LIMIT, WINDOW_MS)],
		['sliding counter', () => new SlidingWindowCounter(LIMIT, WINDOW_MS)]
	];
	for (const [name, make] of makers) {
		const result = memory(make);
		console.log(
			`   ${padEnd(name, LABEL)}${padLeft(result.entries, COL)}${padLeft(result.bytesPerUser.toFixed(0), COL)}`
		);
	}
	console.log('');
}

main();
