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
		`\n=== Lesson 9.5 — Several instances, one limit ===\n` +
			`   ${PORTS.length} Express instances · limit ${LIMIT} requests per ${WINDOW_MS} ms per user\n` +
			`   one user sends ${ATTEMPTS} requests round robin (the way a gateway would spread them)\n`
	);

	const perInstance = await scenario('each instance counts its own', () =>
		PORTS.map(() => new SlidingWindowCounter(LIMIT, WINDOW_MS))
	);

	const oneStore = sharedStore(new SlidingWindowCounter(LIMIT, WINDOW_MS), STORE_RTT_MS);
	const shared = await scenario(`shared store (RTT ${STORE_RTT_MS} ms)`, () =>
		PORTS.map(() => oneStore)
	);

	console.log(
		`   ${padEnd('where counted', LABEL)}${padLeft('200', COL)}${padLeft('429', COL)}${padLeft('real limit', COL)}${padLeft('p99', COL)}${padLeft('store call', COL)}`
	);
	for (const result of [perInstance, shared])
		console.log(
			`   ${padEnd(result.label, LABEL)}${padLeft(result.ok, COL)}${padLeft(result.limited, COL)}` +
				padLeft(`${(result.ok / LIMIT).toFixed(1)}x`, COL) +
				padLeft(ms(result.p99), COL) +
				padLeft(result.storeCalls, COL)
		);

	console.log(
		`\n   ${PORTS.length} instances, each counting its own — the user got ${perInstance.ok}, i.e. ` +
			`${(perInstance.ok / LIMIT).toFixed(1)} times the limit (equal to the instance count).\n` +
			`   with a shared store exactly ${shared.ok} — the price: one store call per request (${shared.storeCalls} / ${ATTEMPTS} requests).\n` +
			`   here p99 is ${ms(perInstance.p99)} vs ${ms(shared.p99)} — this difference could not be measured, because the store is in the same process\n` +
			`   and the RTT is only a ${STORE_RTT_MS} ms pretence. With real Redis (especially in another AZ) it is added to every request.\n` +
			`   the bigger price is not latency — the store is now a hard dependency: when it dies, fail open (no limit) or fail closed (all 429)?\n`
	);

	console.log(`── What the 429 response looks like ──`);
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
			`   attempt ${i + 1}: status ${reply.status} · x-ratelimit-remaining: ${reply.remaining}` +
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
