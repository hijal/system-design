import { env, fmix32, heading, n, pct, row } from './util';

const API_RPS = env('API_RPS', 500_000);
const KEYS = env('ACTIVE_KEYS', 300_000);
const ZIPF_S = env('ZIPF_S', 1.0);
const SHARDS = env('SHARDS', 16);
const SHARD_OPS = env('SHARD_OPS', 100_000);
const API_SERVERS = env('API_SERVERS', 400);
const BIG_TENANT_RPS = env('BIG_TENANT_RPS', 1_000);
const BURST_SECONDS = env('BURST_SECONDS', 0.2);
const SPLIT = env('SPLIT', 8);

const SLOTS = 16_384;
const rates: number[] = [];
{
	let harmonic = 0;
	for (let i = 1; i <= KEYS; i++) harmonic += 1 / Math.pow(i, ZIPF_S);
	for (let i = 1; i <= KEYS; i++) rates.push(API_RPS / (Math.pow(i, ZIPF_S) * harmonic));
}
const slotOf = (key: string): number => {
	let h = 0;
	for (let i = 0; i < key.length; i++) h = fmix32(h ^ key.charCodeAt(i)) + i;
	return fmix32(h) % SLOTS;
};
const shardOf = (key: string, shards: number): number => Math.floor((slotOf(key) * shards) / SLOTS);

type Plan = {
	name: string;
	shards: number;
	opsFor: (key: number, rate: number) => [string, number][];
};

const leaseSize = (rate: number): number =>
	Math.max(1, Math.floor((rate * BURST_SECONDS) / API_SERVERS));

const plans: Plan[] = [
	{
		name: `one op per request, ${SHARDS} shards`,
		shards: SHARDS,
		opsFor: (k, r) => [[`rl:${k}`, r]]
	},
	{
		name: `the same, ${SHARDS * 2} shards`,
		shards: SHARDS * 2,
		opsFor: (k, r) => [[`rl:${k}`, r]]
	},
	{
		name: `leases on big tenants (> ${n(BIG_TENANT_RPS)}/s)`,
		shards: SHARDS,
		opsFor: (k, r) => [[`rl:${k}`, r > BIG_TENANT_RPS ? r / leaseSize(r) : r]]
	},
	{
		name: `big tenants' keys split ${SPLIT} ways (rl:k#0..${SPLIT - 1})`,
		shards: SHARDS,
		opsFor: (k, r) =>
			r > BIG_TENANT_RPS
				? Array.from({ length: SPLIT }, (_, i): [string, number] => [`rl:${k}#${i}`, r / SPLIT])
				: [[`rl:${k}`, r]]
	}
];

heading(
	`${n(API_RPS)} requests/s, ${n(KEYS)} active keys, Zipf (s = ${ZIPF_S}), ~${n(SHARD_OPS)} op/s capacity per shard`
);
const top = rates[0] ?? 0;
console.log(
	`biggest tenant: ${n(top)} req/s (${pct(top, API_RPS, 1)}); tenants above ${n(BIG_TENANT_RPS)}/s: ${n(rates.filter((r) => r > BIG_TENANT_RPS).length)}\n`
);
console.log(
	row([
		['plan', 44],
		['total op/s', 12],
		['avg shard', 11],
		['busiest shard', 15],
		['of capacity', 13],
		['busiest / avg', 15]
	])
);
for (const plan of plans) {
	const load = new Array<number>(plan.shards).fill(0);
	rates.forEach((rate, i) => {
		for (const [key, ops] of plan.opsFor(i, rate)) {
			const shard = shardOf(key, plan.shards);
			load[shard] = (load[shard] ?? 0) + ops;
		}
	});
	const total = load.reduce((a, b) => a + b, 0);
	const busiest = Math.max(...load);
	const average = total / plan.shards;
	console.log(
		row([
			[plan.name, 44],
			[n(total), 12],
			[n(average), 11],
			[n(busiest), 15],
			[pct(busiest, SHARD_OPS, 0), 13],
			[`${(busiest / average).toFixed(2)}x`, 15]
		])
	);
}
console.log(
	`\nA big tenant's lease: the ${BURST_SECONDS} s burst of its limit ÷ ${API_SERVERS} servers — ${leaseSize(top)} tokens for the biggest tenant.`
);
console.log(
	`key splitting: limit / ${SPLIT} in each part, and the server picks a part at random for each request — so the parts get even traffic.`
);
