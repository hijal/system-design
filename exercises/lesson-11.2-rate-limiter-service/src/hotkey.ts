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
		name: `প্রতি request এ এক op, ${SHARDS}টা shard`,
		shards: SHARDS,
		opsFor: (k, r) => [[`rl:${k}`, r]]
	},
	{
		name: `একই, ${SHARDS * 2}টা shard`,
		shards: SHARDS * 2,
		opsFor: (k, r) => [[`rl:${k}`, r]]
	},
	{
		name: `বড় tenant (> ${n(BIG_TENANT_RPS)}/s) এ lease`,
		shards: SHARDS,
		opsFor: (k, r) => [[`rl:${k}`, r > BIG_TENANT_RPS ? r / leaseSize(r) : r]]
	},
	{
		name: `বড় tenant এর key ${SPLIT} ভাগে (rl:k#0..${SPLIT - 1})`,
		shards: SHARDS,
		opsFor: (k, r) =>
			r > BIG_TENANT_RPS
				? Array.from({ length: SPLIT }, (_, i): [string, number] => [`rl:${k}#${i}`, r / SPLIT])
				: [[`rl:${k}`, r]]
	}
];

heading(
	`${n(API_RPS)} request/s, ${n(KEYS)}টা সক্রিয় key, Zipf (s = ${ZIPF_S}), shard প্রতি ক্ষমতা ~${n(SHARD_OPS)} op/s`
);
const top = rates[0] ?? 0;
console.log(
	`সবচেয়ে বড় tenant: ${n(top)} req/s (${pct(top, API_RPS, 1)}); ${n(BIG_TENANT_RPS)}/s এর বেশি এমন tenant: ${n(rates.filter((r) => r > BIG_TENANT_RPS).length)}টা\n`
);
console.log(
	row([
		['পরিকল্পনা', 44],
		['মোট op/s', 12],
		['গড় shard', 11],
		['ব্যস্ততম shard', 15],
		['ক্ষমতার', 9],
		['ব্যস্ততম / গড়', 14]
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
			[pct(busiest, SHARD_OPS, 0), 9],
			[`${(busiest / average).toFixed(2)}x`, 14]
		])
	);
}
console.log(
	`\nবড় tenant এর lease: তার সীমার ${BURST_SECONDS} s এর burst ÷ ${API_SERVERS}টা server — সবচেয়ে বড় tenant এ ${leaseSize(top)}টা token।`
);
console.log(
	`key ভাগ করা: প্রতিটা ভাগে সীমা / ${SPLIT}, server প্রতি request এ একটা ভাগ এলোমেলো বাছে — তাই ভাগগুলোয় traffic সমান।`
);
