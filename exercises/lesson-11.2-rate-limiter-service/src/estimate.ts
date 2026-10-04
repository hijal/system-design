import { bytes, env, heading, n, row, share } from './util';

const API_RPS = env('API_RPS', 500_000);
const API_SERVERS = env('API_SERVERS', 400);
const ACTIVE_KEYS = env('ACTIVE_KEYS', 300_000);
const RULES = env('RULES', 2);
const SHARD_OPS = env('SHARD_OPS', 100_000);
const HEADROOM = env('HEADROOM', 0.5);
const STATE_BYTES = env('STATE_BYTES', 150);
const MESSAGE_BYTES = env('MESSAGE_BYTES', 150);
const CROSS_AZ_SHARE = env('CROSS_AZ_SHARE', 2 / 3);
const CROSS_AZ_PER_GB = env('CROSS_AZ_PER_GB', 0.02);
const API_P99_MS = env('API_P99_MS', 50);
const LIMITER_P99_MS = env('LIMITER_P99_MS', 1);

const SECONDS_PER_MONTH = 30 * 86_400;

heading(
	`অংশ ক — চাপ: peak এ ${n(API_RPS)} API request/s, ${n(API_SERVERS)}টা API server, প্রতি request এ ${RULES}টা নিয়ম`
);
const layouts: { name: string; opsPerRequest: number }[] = [
	{ name: 'প্রতি নিয়মে আলাদা Redis call', opsPerRequest: RULES },
	{ name: 'সব নিয়ম একটা Lua script এ (একই shard এ)', opsPerRequest: 1 }
];
console.log(
	row([
		['', 54],
		['Redis op/s', 14],
		['shard লাগে', 12],
		['network', 14],
		['cross-AZ / মাস', 16]
	])
);
for (const layout of layouts) {
	const ops = API_RPS * layout.opsPerRequest;
	const shards = Math.ceil(ops / (SHARD_OPS * (1 - HEADROOM)));
	const bandwidth = ops * MESSAGE_BYTES * 2;
	const crossAz = ((bandwidth * SECONDS_PER_MONTH) / 1e9) * CROSS_AZ_SHARE * CROSS_AZ_PER_GB;
	console.log(
		row([
			[layout.name, 54],
			[n(ops), 14],
			[n(shards), 12],
			[`${bytes(bandwidth)}/s`, 14],
			[`$${n(crossAz)}`, 16]
		])
	);
}
console.log(
	`shard প্রতি ~${n(SHARD_OPS)} op/s (Lua সহ, ধরে নেওয়া), ${share(HEADROOM, 0)} ফাঁকা রেখে; message প্রতি ${MESSAGE_BYTES} B দুই দিকে; ${share(CROSS_AZ_SHARE, 0)} call অন্য AZ এ, $${CROSS_AZ_PER_GB}/GB`
);

heading('অংশ খ — memory: সক্রিয় key এর অবস্থা');
console.log(
	row([
		['', 54],
		['key × নিয়ম', 14],
		['memory', 12]
	])
);
console.log(
	row([
		[`token bucket, ${n(ACTIVE_KEYS)} সক্রিয় key (${STATE_BYTES} B/অবস্থা)`, 54],
		[n(ACTIVE_KEYS * RULES), 14],
		[bytes(ACTIVE_KEYS * RULES * STATE_BYTES), 12]
	])
);
console.log(
	row([
		['sliding log, ঘণ্টায় 1,000 সীমা, একই key গুলো (16 B/entry)', 54],
		[n(ACTIVE_KEYS), 14],
		[bytes(ACTIVE_KEYS * 1_000 * 16), 12]
	])
);

heading(`অংশ গ — latency এর বাজেট: API এর p99 ${API_P99_MS} ms, limiter পায় ${LIMITER_P99_MS} ms`);
console.log(
	`limiter এর অংশ: ${share(LIMITER_P99_MS / API_P99_MS, 0)}; প্রতি request এ এই বাজেটের ভেতরে একটা network round trip, একটা Lua script, আর কোনো retry না।`
);
console.log(
	`একটা API server এ ${n(API_RPS / API_SERVERS)} request/s — limiter ${LIMITER_P99_MS} ms ধরে রাখলে একসাথে ~${n((API_RPS / API_SERVERS) * (LIMITER_P99_MS / 1_000))}টা অপেক্ষায়; ${n(50)} ms ধীর হলে ~${n((API_RPS / API_SERVERS) * 0.05)}টা।`
);
