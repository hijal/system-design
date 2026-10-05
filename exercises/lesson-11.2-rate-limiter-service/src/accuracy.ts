import { Scheduler, TokenBucket } from './sim';
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
const LIMIT = env('LIMIT', 1_000);
const BURST = env('BURST', 200);
const SECONDS = env('SECONDS', 10);
const RTT_MS = env('RTT_MS', 0.5);
const RTT_SIGMA = env('RTT_SIGMA', 0.4);
const LEASE = env('LEASE', 4);
const LEASE_TTL_MS = env('LEASE_TTL_MS', 1_000);
const SYNC_MS = env('SYNC_MS', 100);
const HOT_SERVERS = env('HOT_SERVERS', 5);
const HOT_SHARE = env('HOT_SHARE', 0.9);

interface Scenario {
	name: string;
	demand: number;
	skewed: boolean;
}

interface Outcome {
	admitted: number;
	rejected: number;
	maxWindow: number;
	centralOps: number;
	latencies: number[];
}

type Strategy = {
	name: string;
	run: (arrivals: readonly Arrival[], random: () => number) => Outcome;
};

interface Arrival {
	at: number;
	server: number;
}

function arrivalsFor(scenario: Scenario, random: () => number): Arrival[] {
	const out: Arrival[] = [];
	let t = 0;
	const end = SECONDS * 1_000;
	for (;;) {
		t += exponential(random, 1_000 / scenario.demand);
		if (t >= end) break;
		const server =
			scenario.skewed && random() < HOT_SHARE
				? Math.floor(random() * HOT_SERVERS)
				: Math.floor(random() * SERVERS);
		out.push({ at: t, server });
	}
	return out;
}

function maxOneSecond(times: number[]): number {
	times.sort((a, b) => a - b);
	let best = 0;
	let lo = 0;
	for (let hi = 0; hi < times.length; hi++) {
		while ((times[hi] ?? 0) - (times[lo] ?? 0) >= 1_000) lo++;
		best = Math.max(best, hi - lo + 1);
	}
	return best;
}

function tally(
	admittedAt: number[],
	rejected: number,
	centralOps: number,
	latencies: number[]
): Outcome {
	return {
		admitted: admittedAt.length,
		rejected,
		maxWindow: maxOneSecond(admittedAt),
		centralOps,
		latencies
	};
}

const rtt = (random: () => number): number => lognormal(random, RTT_MS, RTT_SIGMA);

function leaseStrategy(size: number): Strategy {
	return {
		name: `token lease (${size} at a time, wait if not granted)`,
		run: (arrivals, random) => {
			const s = new Scheduler();
			const central = new TokenBucket(LIMIT, BURST);
			const local = Array.from({ length: SERVERS }, () => ({
				tokens: 0,
				expires: 0,
				waiting: [] as number[],
				pending: false,
				denyUntil: 0
			}));
			const admitted: number[] = [];
			const latencies: number[] = [];
			let rejected = 0;
			let ops = 0;
			const requestLease = (server: number): void => {
				const state = local[server];
				if (state === undefined || state.pending) return;
				state.pending = true;
				ops++;
				const r = rtt(random);
				s.at(s.now + r / 2, () => {
					const full = central.peek(s.now) >= size;
					const granted = full ? central.take(s.now, size) : 0;
					const wait = full ? 0 : ((size - central.peek(s.now)) / LIMIT) * 1_000;
					s.at(s.now + r / 2, () => {
						state.pending = false;
						state.tokens = granted;
						state.expires = s.now + LEASE_TTL_MS;
						state.denyUntil = s.now + wait;
						const queue = state.waiting;
						state.waiting = [];
						for (const arrived of queue) {
							if (state.tokens >= 1) {
								state.tokens--;
								admitted.push(s.now);
								latencies.push(s.now - arrived);
							} else if (granted > 0) {
								state.waiting.push(arrived);
							} else {
								rejected++;
								latencies.push(s.now - arrived);
							}
						}
						if (state.waiting.length > 0) requestLease(server);
					});
				});
			};
			for (const a of arrivals) {
				s.at(a.at, () => {
					const state = local[a.server];
					if (state === undefined) return;
					if (s.now >= state.expires) state.tokens = 0;
					if (state.tokens >= 1) {
						state.tokens--;
						admitted.push(s.now);
						latencies.push(0);
						return;
					}
					if (s.now < state.denyUntil) {
						rejected++;
						latencies.push(0);
						return;
					}
					state.waiting.push(s.now);
					requestLease(a.server);
				});
			}
			s.run();
			return tally(admitted, rejected, ops, latencies);
		}
	};
}

const strategies: Strategy[] = [
	{
		name: 'each server its own bucket (full limit)',
		run: (arrivals) => {
			const buckets = Array.from({ length: SERVERS }, () => new TokenBucket(LIMIT, BURST));
			const admitted: number[] = [];
			let rejected = 0;
			for (const a of arrivals) {
				if ((buckets[a.server]?.take(a.at) ?? 0) === 1) admitted.push(a.at);
				else rejected++;
			}
			return tally(
				admitted,
				rejected,
				0,
				arrivals.map(() => 0)
			);
		}
	},
	{
		name: 'split the limit (limit / N on each server)',
		run: (arrivals) => {
			const buckets = Array.from(
				{ length: SERVERS },
				() => new TokenBucket(LIMIT / SERVERS, Math.max(1, BURST / SERVERS))
			);
			const admitted: number[] = [];
			let rejected = 0;
			for (const a of arrivals) {
				if ((buckets[a.server]?.take(a.at) ?? 0) === 1) admitted.push(a.at);
				else rejected++;
			}
			return tally(
				admitted,
				rejected,
				0,
				arrivals.map(() => 0)
			);
		}
	},
	{
		name: 'central, every request, atomic (Lua)',
		run: (arrivals, random) => {
			const s = new Scheduler();
			const central = new TokenBucket(LIMIT, BURST);
			const admitted: number[] = [];
			const latencies: number[] = [];
			let rejected = 0;
			for (const a of arrivals) {
				const r = rtt(random);
				s.at(a.at + r / 2, () => {
					if (central.take(s.now) === 1) admitted.push(s.now);
					else rejected++;
				});
				latencies.push(r);
			}
			s.run();
			return tally(admitted, rejected, arrivals.length, latencies);
		}
	},
	{
		name: 'central, GET then SET (not atomic)',
		run: (arrivals, random) => {
			const s = new Scheduler();
			const central = new TokenBucket(LIMIT, BURST);
			const admitted: number[] = [];
			const latencies: number[] = [];
			let rejected = 0;
			for (const a of arrivals) {
				const first = rtt(random);
				const second = rtt(random);
				s.at(a.at + first / 2, () => {
					const seen = central.peek(s.now);
					if (seen < 1) {
						rejected++;
						return;
					}
					s.at(a.at + first + second / 2, () => central.overwrite(s.now, seen - 1));
					admitted.push(a.at + first);
				});
				latencies.push(first + second);
			}
			s.run();
			return tally(admitted, rejected, arrivals.length * 2, latencies);
		}
	},
	leaseStrategy(LEASE),
	{
		name: `local + sync every ${SYNC_MS} ms (async)`,
		run: (arrivals) => {
			const slots = Math.round(1_000 / SYNC_MS);
			const history: number[] = [];
			let globalView = 0;
			const sinceSync = new Array<number>(SERVERS).fill(0);
			let nextSync = SYNC_MS;
			const admitted: number[] = [];
			let rejected = 0;
			let ops = 0;
			for (const a of arrivals) {
				while (a.at >= nextSync) {
					const total = sinceSync.reduce((sum, v) => sum + v, 0);
					history.push(total);
					if (history.length > slots) history.shift();
					globalView = history.reduce((sum, v) => sum + v, 0);
					sinceSync.fill(0);
					ops += SERVERS;
					nextSync += SYNC_MS;
				}
				const own = sinceSync[a.server] ?? 0;
				if (globalView + own < LIMIT) {
					sinceSync[a.server] = own + 1;
					admitted.push(a.at);
				} else rejected++;
			}
			return tally(
				admitted,
				rejected,
				ops,
				arrivals.map(() => 0)
			);
		}
	}
];

const scenarios: Scenario[] = [
	{
		name: `demand 2× the limit, spread evenly over ${SERVERS} servers`,
		demand: LIMIT * 2,
		skewed: false
	},
	{
		name: `demand 2× the limit, ${pct(HOT_SHARE, 1, 0)} of traffic on ${HOT_SERVERS} servers`,
		demand: LIMIT * 2,
		skewed: true
	},
	{
		name: `attack: demand 20× the limit, spread evenly over ${SERVERS} servers`,
		demand: LIMIT * 20,
		skewed: false
	},
	{
		name: `demand at 80% of the limit (nobody should be blocked), ${pct(HOT_SHARE, 1, 0)} of traffic on ${HOT_SERVERS} servers`,
		demand: LIMIT * 0.8,
		skewed: true
	}
];

console.log(
	`one API key, limit ${n(LIMIT)}/s (burst ${n(BURST)}), ${SERVERS} API servers, ${SECONDS} s; the centre's RTT median ${RTT_MS} ms`
);
for (const scenario of scenarios) {
	heading(scenario.name);
	console.log(
		row([
			['strategy', 48],
			['accepted/s', 12],
			['of limit', 10],
			['highest in 1 s', 18],
			['blocked', 9],
			['centre op/s', 14],
			['extra p50', 11],
			['extra p99', 11]
		])
	);
	for (const strategy of strategies) {
		const arrivals = arrivalsFor(scenario, mulberry32(SEED));
		const outcome = strategy.run(arrivals, mulberry32(SEED + 1));
		const sorted = [...outcome.latencies].sort((a, b) => a - b);
		const perSecond = outcome.admitted / SECONDS;
		console.log(
			row([
				[strategy.name, 48],
				[n(perSecond), 12],
				[`${(perSecond / LIMIT).toFixed(2)}x`, 10],
				[`${(outcome.maxWindow / LIMIT).toFixed(2)}x`, 18],
				[pct(outcome.rejected, arrivals.length, 1), 9],
				[n(outcome.centralOps / SECONDS), 14],
				[ms(percentile(sorted, 50)), 11],
				[ms(percentile(sorted, 99)), 11]
			])
		);
	}
}
console.log(
	'\n"highest in 1 s" = the most accepted in any one-second window — ~1.2x (limit + burst) when a token bucket holds.'
);

heading(
	`lease size: ${SERVERS} servers, burst ${n(BURST)} — when lease × servers passes the burst`
);
console.log(
	row([
		['lease', 8],
		['lease × server', 16],
		['2x, 5 servers: accepted', 25],
		['centre op/s', 14],
		['80%: wrongly blocked', 22],
		['centre op/s', 14]
	])
);
for (const size of [1, 2, 4, 10, 20, 50]) {
	const strategy = leaseStrategy(size);
	const busy = scenarios[1];
	const calm = scenarios[3];
	if (busy === undefined || calm === undefined) break;
	const busyArrivals = arrivalsFor(busy, mulberry32(SEED));
	const calmArrivals = arrivalsFor(calm, mulberry32(SEED));
	const b = strategy.run(busyArrivals, mulberry32(SEED + 1));
	const c = strategy.run(calmArrivals, mulberry32(SEED + 1));
	console.log(
		row([
			[size, 8],
			[n(size * SERVERS), 16],
			[`${(b.admitted / SECONDS / LIMIT).toFixed(2)}x`, 25],
			[n(b.centralOps / SECONDS), 14],
			[pct(c.rejected, calmArrivals.length, 1), 22],
			[n(c.centralOps / SECONDS), 14]
		])
	);
}
