import http from 'node:http';
import { SlidingWindowCounter, type RateLimiter } from './limiters';
import { startInstance, type Instance, type SharedStore } from './server';
import { ms, padEnd, padLeft, percentile, sleep } from './random';

const PORTS = [4401, 4402, 4403];
const LIMIT = Number(process.env.LIMIT ?? 10);
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 1000);
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 60);
const STORE_RTT_MS = Number(process.env.STORE_RTT_MS ?? 1);

const LABEL = 30;
const COL = 14;

type Reply = {
	status: number;
	servedBy: string;
	remaining: string;
	retryAfter: string;
	ms: number;
};

function get(agent: http.Agent, url: string, userId: string): Promise<Reply> {
	const started = performance.now();
	return new Promise((resolve) => {
		const req = http.get(`${url}/tasks`, { agent, headers: { 'x-user-id': userId } }, (res) => {
			res.resume();
			res.on('end', () =>
				resolve({
					status: res.statusCode ?? 0,
					servedBy: String(res.headers['x-served-by'] ?? ''),
					remaining: String(res.headers['x-ratelimit-remaining'] ?? ''),
					retryAfter: String(res.headers['retry-after'] ?? ''),
					ms: performance.now() - started
				})
			);
		});
		req.on('error', () =>
			resolve({
				status: 0,
				servedBy: '',
				remaining: '',
				retryAfter: '',
				ms: performance.now() - started
			})
		);
	});
}

function sharedStore(limiter: RateLimiter, rttMs: number): SharedStore {
	let calls = 0;
	return {
		async check(key, now) {
			calls += 1;
			if (rttMs > 0) await sleep(rttMs);
			const decision = limiter.check(key, now);
			return {
				allowed: decision.allowed,
				remaining: decision.remaining,
				retryAfterMs: decision.retryAfterMs
			};
		},
		calls: () => calls
	};
}

async function driveRoundRobin(
	agent: http.Agent,
	instances: Instance[],
	userId: string,
	attempts: number
): Promise<Reply[]> {
	const replies: Reply[] = [];
	for (let i = 0; i < attempts; i += 1) {
		const target = instances[i % instances.length];
		if (!target) continue;
		replies.push(await get(agent, target.url, userId));
	}
	return replies;
}

async function scenario(
	label: string,
	make: () => Array<RateLimiter | SharedStore>
): Promise<{ label: string; ok: number; limited: number; p99: number; storeCalls: number }> {
	const limiters = make();
	const instances: Instance[] = [];
	for (const [index, port] of PORTS.entries()) {
		const limiter = limiters[index] ?? limiters[0];
		if (!limiter) throw new Error('limiter missing');
		instances.push(await startInstance(`inst-${index + 1}`, port, limiter, LIMIT));
	}
	const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
	await driveRoundRobin(agent, instances, 'warmup-user', PORTS.length * 4);
	const first = limiters[0];
	const callsBefore = first && 'calls' in first ? first.calls() : 0;
	const replies = await driveRoundRobin(agent, instances, 'user-7', ATTEMPTS);
	agent.destroy();
	for (const instance of instances) await instance.stop();
	await sleep(60);
	const storeCalls = (first && 'calls' in first ? first.calls() : 0) - callsBefore;
	return {
		label,
		ok: replies.filter((r) => r.status === 200).length,
		limited: replies.filter((r) => r.status === 429).length,
		p99: percentile(
			replies.map((r) => r.ms),
			99
		),
		storeCalls
	};
}

async function main(): Promise<void> {
	console.log(
		`\n=== Lesson 9.5 — কয়েকটা instance, একটাই সীমা ===\n` +
			`   ${PORTS.length} টা Express instance · সীমা ${LIMIT} request প্রতি ${WINDOW_MS} ms প্রতি user\n` +
			`   একজন user round robin এ ${ATTEMPTS} টা request পাঠাচ্ছে (gateway যেভাবে ভাগ করে দিত)\n`
	);

	const perInstance = await scenario('প্রতি instance এর নিজের গোনা', () =>
		PORTS.map(() => new SlidingWindowCounter(LIMIT, WINDOW_MS))
	);

	const oneStore = sharedStore(new SlidingWindowCounter(LIMIT, WINDOW_MS), STORE_RTT_MS);
	const shared = await scenario(`ভাগ করা store (RTT ${STORE_RTT_MS} ms)`, () =>
		PORTS.map(() => oneStore)
	);

	console.log(
		`   ${padEnd('গোনা কোথায়', LABEL)}${padLeft('200', COL)}${padLeft('429', COL)}${padLeft('আসল সীমা', COL)}${padLeft('p99', COL)}${padLeft('store call', COL)}`
	);
	for (const result of [perInstance, shared])
		console.log(
			`   ${padEnd(result.label, LABEL)}${padLeft(result.ok, COL)}${padLeft(result.limited, COL)}` +
				padLeft(`${(result.ok / LIMIT).toFixed(1)}x`, COL) +
				padLeft(ms(result.p99), COL) +
				padLeft(result.storeCalls, COL)
		);

	console.log(
		`\n   ${PORTS.length} টা instance, প্রত্যেকের নিজের গোনা — user পেল ${perInstance.ok} টা, মানে সীমার ` +
			`${(perInstance.ok / LIMIT).toFixed(1)} গুণ (instance সংখ্যার সমান)।\n` +
			`   ভাগ করা store এ ঠিক ${shared.ok} টা — দাম: প্রতিটা request এ একটা করে store call (${shared.storeCalls} টা / ${ATTEMPTS} টা request)।\n` +
			`   এখানে p99 ${ms(perInstance.p99)} বনাম ${ms(shared.p99)} — এই পার্থক্যটা মাপা যায়নি, কারণ store টা একই process এ\n` +
			`   আর RTT মাত্র ${STORE_RTT_MS} ms এর একটা ভান। আসল Redis এ (বিশেষত অন্য AZ তে) এটা প্রতিটা request এ যোগ হয়।\n` +
			`   বড় দামটা latency না — store এখন একটা hard dependency: সে মরলে fail open (সীমা নেই) নাকি fail closed (সব 429)?\n`
	);

	console.log(`── 429 এর উত্তরটা কেমন দেখায় ──`);
	const solo = await startInstance(
		'inst-1',
		PORTS[0] ?? 4401,
		new SlidingWindowCounter(2, WINDOW_MS),
		2
	);
	const soloAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
	for (let i = 0; i < 4; i += 1) {
		const reply = await get(soloAgent, solo.url, 'user-9');
		console.log(
			`   চেষ্টা ${i + 1}: status ${reply.status} · x-ratelimit-remaining: ${reply.remaining}` +
				(reply.retryAfter ? ` · retry-after: ${reply.retryAfter}s` : '')
		);
	}
	soloAgent.destroy();
	await solo.stop();
	console.log('');
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
