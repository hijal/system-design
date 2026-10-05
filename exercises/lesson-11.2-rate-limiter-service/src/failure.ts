import { TokenBucket } from './sim';
import {
	env,
	exponential,
	heading,
	lognormal,
	ms,
	mulberry32,
	n,
	pct,
	percentile,
	row
} from './util';

const SEED = env('SEED', 11);
const SERVERS = env('SERVERS', 50);
const NORMAL_KEYS = env('NORMAL_KEYS', 200);
const NORMAL_DEMAND = env('NORMAL_DEMAND', 10);
const NORMAL_LIMIT = env('NORMAL_LIMIT', 50);
const ABUSER_DEMAND = env('ABUSER_DEMAND', 1_000);
const ABUSER_LIMIT = env('ABUSER_LIMIT', 100);
const HEALTHY_MS = env('HEALTHY_MS', 0.5);
const SLOW_MS = env('SLOW_MS', 40);
const HANG_MS = env('HANG_MS', 30_000);
const TIMEOUT_MS = env('TIMEOUT_MS', 5);
const BREAKER_WINDOW_MS = env('BREAKER_WINDOW_MS', 1_000);
const BREAKER_OPEN_MS = env('BREAKER_OPEN_MS', 5_000);
const PHASE_S = env('PHASE_S', 20);
const PER_SERVER_RPS = env('PER_SERVER_RPS', 1_250);
const SLACK = env('SLACK', 3);

type Phase = 'healthy' | 'slow' | 'down';
type Mode = 'open' | 'closed' | 'local';

interface Policy {
	name: string;
	timeout: number;
	mode: Mode;
	breaker: boolean;
	slack: number;
}

const policies: Policy[] = [
	{
		name: 'no timeout, wait for the answer',
		timeout: Number.POSITIVE_INFINITY,
		mode: 'closed',
		breaker: false,
		slack: 1
	},
	{
		name: `timeout ${TIMEOUT_MS} ms → fail open`,
		timeout: TIMEOUT_MS,
		mode: 'open',
		breaker: false,
		slack: 1
	},
	{
		name: `timeout ${TIMEOUT_MS} ms → fail closed (503)`,
		timeout: TIMEOUT_MS,
		mode: 'closed',
		breaker: false,
		slack: 1
	},
	{
		name: `timeout ${TIMEOUT_MS} ms → local bucket (limit / N)`,
		timeout: TIMEOUT_MS,
		mode: 'local',
		breaker: false,
		slack: 1
	},
	{
		name: `+ breaker → local bucket, generous (${SLACK} × limit / N)`,
		timeout: TIMEOUT_MS,
		mode: 'local',
		breaker: true,
		slack: SLACK
	}
];

interface Stats {
	latencies: number[];
	normal: number;
	normalRejected: number;
	abuserAdmitted: number;
}

function simulate(policy: Policy, phase: Phase): Stats {
	const random = mulberry32(SEED);
	const central = new Map<number, TokenBucket>();
	const local = new Map<string, TokenBucket>();
	const limitOf = (key: number): number => (key === 0 ? ABUSER_LIMIT : NORMAL_LIMIT);
	const centralBucket = (key: number): TokenBucket => {
		let b = central.get(key);
		if (b === undefined) {
			b = new TokenBucket(limitOf(key), limitOf(key));
			central.set(key, b);
		}
		return b;
	};
	const localBucket = (key: number, server: number): TokenBucket => {
		const id = `${key}:${server}`;
		let b = local.get(id);
		if (b === undefined) {
			b = new TokenBucket(
				(limitOf(key) * policy.slack) / SERVERS,
				Math.max(1, (limitOf(key) * policy.slack) / SERVERS)
			);
			local.set(id, b);
		}
		return b;
	};
	const stats: Stats = { latencies: [], normal: 0, normalRejected: 0, abuserAdmitted: 0 };
	const end = PHASE_S * 1_000;
	const totalRate = NORMAL_KEYS * NORMAL_DEMAND + ABUSER_DEMAND;
	const failures: number[] = [];
	let openUntil = Number.NEGATIVE_INFINITY;
	let t = 0;
	for (;;) {
		t += exponential(random, 1_000 / totalRate);
		if (t >= end) break;
		const key = random() < ABUSER_DEMAND / totalRate ? 0 : 1 + Math.floor(random() * NORMAL_KEYS);
		const server = Math.floor(random() * SERVERS);
		const store =
			phase === 'healthy'
				? lognormal(random, HEALTHY_MS, 0.4)
				: phase === 'slow'
					? lognormal(random, SLOW_MS, 0.5)
					: HANG_MS;
		let allowed: boolean;
		let waited: number;
		const skip = policy.breaker && t < openUntil;
		if (!skip && store <= policy.timeout) {
			waited = store;
			allowed = centralBucket(key).take(t + store) === 1;
		} else {
			waited = skip ? 0 : policy.timeout;
			if (!skip && policy.breaker) {
				failures.push(t);
				while ((failures[0] ?? t) < t - BREAKER_WINDOW_MS) failures.shift();
				if (failures.length >= 20) openUntil = t + BREAKER_OPEN_MS;
			}
			allowed =
				policy.mode === 'open'
					? true
					: policy.mode === 'closed'
						? false
						: localBucket(key, server).take(t) === 1;
		}
		stats.latencies.push(waited);
		if (key === 0) {
			if (allowed) stats.abuserAdmitted++;
		} else {
			stats.normal++;
			if (!allowed) stats.normalRejected++;
		}
	}
	stats.latencies.sort((a, b) => a - b);
	return stats;
}

console.log(
	`One Redis shard's keys: ${NORMAL_KEYS} ordinary keys (demand ${NORMAL_DEMAND}/s, limit ${NORMAL_LIMIT}/s) and one abuser (demand ${n(ABUSER_DEMAND)}/s, limit ${ABUSER_LIMIT}/s); ${SERVERS} API servers, ${PHASE_S} s per state`
);
const phases: [Phase, string][] = [
	['healthy', `healthy (store median ${HEALTHY_MS} ms)`],
	['slow', `store slow (median ${SLOW_MS} ms)`],
	['down', `blackhole on the store's network (no answer; TCP gives up after ${HANG_MS / 1_000} s)`]
];
for (const [phase, label] of phases) {
	heading(label);
	console.log(
		row([
			['policy', 54],
			['extra p50', 11],
			['extra p99', 11],
			['hanging per server', 20],
			['ordinary blocked', 18],
			['abuser got', 13]
		])
	);
	for (const policy of policies) {
		const s = simulate(policy, phase);
		const mean = s.latencies.reduce((a, b) => a + b, 0) / Math.max(1, s.latencies.length);
		console.log(
			row([
				[policy.name, 54],
				[ms(percentile(s.latencies, 50)), 11],
				[ms(percentile(s.latencies, 99)), 11],
				[n(PER_SERVER_RPS * (mean / 1_000)), 20],
				[pct(s.normalRejected, s.normal, 1), 18],
				[`${(s.abuserAdmitted / PHASE_S / ABUSER_LIMIT).toFixed(1)}x limit`, 13]
			])
		);
	}
}
console.log(
	`\n"hanging per server" = Little's law: ${n(PER_SERVER_RPS)} requests/s per API server × average wait — how many requests are waiting for the limiter's answer at once.`
);
