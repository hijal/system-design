import { env, heading, ms, mulberry32, n, pct, percentile, row } from './util';

const SEED = env('SEED', 11);
const GATEWAYS = env('GATEWAYS', 300);
const DELIVERIES = env('DELIVERIES', 4_444_444);
const ONLINE = env('ONLINE', 150_000_000);
const REDIS_NODES = env('REDIS_NODES', 10);
const CLIENTS = env('CLIENTS', 500_000);
const CAPACITY = env('CAPACITY', 20_000);
const TICK_MS = env('TICK_MS', 100);
const HORIZON_S = env('HORIZON_S', 600);
const BASE_MS = env('BASE_MS', 1_000);
const CAP_MS = env('CAP_MS', 60_000);
const FIRST_SPREAD_MS = env('FIRST_SPREAD_MS', 10_000);
const REJECT_COST = env('REJECT_COST', 0.2);

heading(
	`Part A - which gateway to send a message to: ${n(DELIVERIES)} deliveries/s at peak, ${GATEWAYS} gateways`
);
console.log(
	row([
		['path', 72],
		['received/s per gateway', 24],
		['useful', 11],
		['op/s in the middle layer', 26]
	])
);
const perGateway = DELIVERIES / GATEWAYS;
const routes: [string, number, number][] = [
	['broadcast to every gateway (one pub/sub channel)', DELIVERIES, DELIVERIES * GATEWAYS],
	[
		`a channel per user, Redis Cluster's old PUBLISH (spread over ${REDIS_NODES} nodes)`,
		perGateway,
		DELIVERIES * REDIS_NODES
	],
	['a channel per user, sharded pub/sub (SPUBLISH)', perGateway, DELIVERIES],
	['session registry (user → gateway) + direct send', perGateway, DELIVERIES * 2]
];
for (const [name, received, middle] of routes) {
	console.log(
		row([
			[name, 72],
			[n(received), 24],
			[pct(perGateway, received, 1), 11],
			[n(middle), 26]
		])
	);
}
console.log(
	'"op/s in the middle layer" - with broadcast every delivery reaches every gateway; with the registry one lookup + one send.'
);

type Policy = {
	name: string;
	delay: (attempt: number, random: () => number) => number;
	first: (random: () => number) => number;
	jitter: boolean;
};

const policies: Policy[] = [
	{ name: 'at once, and again at once on failure', first: () => 0, delay: () => 0, jitter: false },
	{
		name: 'at once, and exactly 1 s later on failure',
		first: () => 0,
		delay: () => 1_000,
		jitter: false
	},
	{
		name: 'exponential backoff, no jitter',
		first: () => 0,
		delay: (attempt) => Math.min(CAP_MS, BASE_MS * 2 ** attempt),
		jitter: false
	},
	{
		name: `first one spread over 0–${FIRST_SPREAD_MS / 1_000} s + full jitter`,
		first: (random) => random() * FIRST_SPREAD_MS,
		delay: (attempt, random) => random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt),
		jitter: true
	}
];

interface Storm {
	peakAttempts: number;
	attempts: number;
	reconnected: number[];
}

function storm(policy: Policy): Storm {
	const random = mulberry32(SEED);
	const ticks = Math.ceil((HORIZON_S * 1_000) / TICK_MS);
	const buckets: Map<number, number>[] = Array.from({ length: ticks + 1 }, () => new Map());
	const schedule = (at: number, attempt: number, count: number): void => {
		const bucket = buckets[Math.min(ticks, Math.floor(at / TICK_MS))];
		if (bucket !== undefined) bucket.set(attempt, (bucket.get(attempt) ?? 0) + count);
	};
	for (let c = 0; c < CLIENTS; c++) schedule(policy.first(random), 0, 1);
	const reconnected: number[] = [];
	let peak = 0;
	let attempts = 0;
	const perTick = (CAPACITY * TICK_MS) / 1_000;
	for (let t = 0; t < ticks; t++) {
		const groups = [...(buckets[t] ?? new Map<number, number>()).entries()].sort(
			(a, b) => a[0] - b[0]
		);
		buckets[t] = new Map();
		const total = groups.reduce((sum, [, count]) => sum + count, 0);
		if (total === 0) continue;
		attempts += total;
		peak = Math.max(peak, (total * 1_000) / TICK_MS);
		const admitted = Math.max(
			0,
			Math.min(total, Math.floor((perTick - REJECT_COST * total) / (1 - REJECT_COST)))
		);
		const now = t * TICK_MS;
		const shares = groups.map(([, count]) => Math.floor((admitted * count) / total));
		let left = admitted - shares.reduce((sum, v) => sum + v, 0);
		groups.forEach(([, count], index) => {
			const extra = Math.min(left, count - (shares[index] ?? 0));
			shares[index] = (shares[index] ?? 0) + extra;
			left -= extra;
		});
		groups.forEach(([attempt, count], index) => {
			const share = shares[index] ?? 0;
			for (let k = 0; k < share; k++) reconnected.push(now + random() * TICK_MS);
			const rejected = count - share;
			if (rejected === 0) return;
			if (policy.jitter) {
				for (let k = 0; k < rejected; k++)
					schedule(now + Math.max(TICK_MS, policy.delay(attempt, random)), attempt + 1, 1);
			} else
				schedule(now + Math.max(TICK_MS, policy.delay(attempt, random)), attempt + 1, rejected);
		});
	}
	reconnected.sort((a, b) => a - b);
	return { peakAttempts: peak, attempts, reconnected };
}

heading(
	`Part B - a gateway died: ${n(CLIENTS)} connections reconnect at once, the rest of the fleet's handshake + auth + sync capacity ${n(CAPACITY)}/s, cost of a rejected attempt ${REJECT_COST}`
);
console.log(
	row([
		['policy', 46],
		['attempts/s (peak)', 19],
		['total attempts', 16],
		['per client', 12],
		['50% back', 10],
		['99% back', 10],
		['all back', 16]
	])
);
const show = (value: number): string =>
	Number.isFinite(value) ? ms(value) : `> ${HORIZON_S / 60} min`;
const results = policies.map((policy) => ({ policy, result: storm(policy) }));
for (const { policy, result } of results) {
	const at = (p: number): string =>
		result.reconnected.length >= CLIENTS * (p / 100) ? ms(percentile(result.reconnected, p)) : '-';
	console.log(
		row([
			[policy.name, 46],
			[n(result.peakAttempts), 19],
			[n(result.attempts), 16],
			[n(result.attempts / CLIENTS), 12],
			[at(50), 10],
			[at(99), 10],
			[
				result.reconnected.length === CLIENTS
					? at(100)
					: `${pct(result.reconnected.length, CLIENTS, 0)} (in ${HORIZON_S / 60} min)`,
				16
			]
		])
	);
}
console.log(
	`best possible: ${n(CLIENTS)} ÷ ${n(CAPACITY)}/s = ${ms((CLIENTS / CAPACITY) * 1_000)}.`
);

heading('Part C - messages to those users during the reconnect window');
const perUser = DELIVERIES / ONLINE;
console.log(
	`${perUser.toFixed(4)} deliveries/s per user → ${n(perUser * CLIENTS)}/s to these ${n(CLIENTS)} people. The registry still points at the dead gateway.\n`
);
console.log(
	row([
		['policy', 46],
		['push only: lost', 18],
		['store first, then push: lost', 30],
		['delay p50', 11],
		['delay p99', 11]
	])
);
for (const { policy, result } of results) {
	const random = mulberry32(SEED + 3);
	const count = Math.round(perUser * CLIENTS * 30);
	let lost = 0;
	const delays: number[] = [];
	for (let i = 0; i < count; i++) {
		const sentAt = random() * 30_000;
		const back =
			result.reconnected[Math.floor(random() * result.reconnected.length)] ??
			Number.POSITIVE_INFINITY;
		if (back > sentAt) {
			lost++;
			delays.push(back - sentAt);
		} else delays.push(0);
	}
	delays.sort((a, b) => a - b);
	console.log(
		row([
			[policy.name, 46],
			[`${n(lost)} (${pct(lost, count, 0)})`, 18],
			['0', 30],
			[show(percentile(delays, 50)), 11],
			[show(percentile(delays, 99)), 11]
		])
	);
}
console.log(
	'messages sent in the first 30 s. With "push only" they go to the registry\'s stale gateway and are lost; with "store first" they stay in the inbox and arrive by sync after the reconnect - late.'
);
