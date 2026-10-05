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
	`Part A — load: ${n(API_RPS)} API requests/s at peak, ${n(API_SERVERS)} API servers, ${RULES} rules per request`
);
const layouts: { name: string; opsPerRequest: number }[] = [
	{ name: 'a separate Redis call per rule', opsPerRequest: RULES },
	{ name: 'all rules in one Lua script (on the same shard)', opsPerRequest: 1 }
];
console.log(
	row([
		['', 54],
		['Redis op/s', 14],
		['shards needed', 15],
		['network', 14],
		['cross-AZ / month', 18]
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
			[n(shards), 15],
			[`${bytes(bandwidth)}/s`, 14],
			[`$${n(crossAz)}`, 18]
		])
	);
}
console.log(
	`~${n(SHARD_OPS)} op/s per shard (with Lua, assumed), keeping ${share(HEADROOM, 0)} free; ${MESSAGE_BYTES} B per message each way; ${share(CROSS_AZ_SHARE, 0)} of calls to another AZ, $${CROSS_AZ_PER_GB}/GB`
);

heading('Part B — memory: the state of active keys');
console.log(
	row([
		['', 62],
		['keys × rules', 14],
		['memory', 12]
	])
);
console.log(
	row([
		[`token bucket, ${n(ACTIVE_KEYS)} active keys (${STATE_BYTES} B/state)`, 62],
		[n(ACTIVE_KEYS * RULES), 14],
		[bytes(ACTIVE_KEYS * RULES * STATE_BYTES), 12]
	])
);
console.log(
	row([
		['sliding log, limit 1,000 an hour, the same keys (16 B/entry)', 62],
		[n(ACTIVE_KEYS), 14],
		[bytes(ACTIVE_KEYS * 1_000 * 16), 12]
	])
);

heading(
	`Part C — the latency budget: the API's p99 is ${API_P99_MS} ms, the limiter gets ${LIMITER_P99_MS} ms`
);
console.log(
	`the limiter's share: ${share(LIMITER_P99_MS / API_P99_MS, 0)}; within this budget, one network round trip per request, one Lua script, and no retries.`
);
console.log(
	`${n(API_RPS / API_SERVERS)} requests/s on one API server — if the limiter holds each for ${LIMITER_P99_MS} ms, ~${n((API_RPS / API_SERVERS) * (LIMITER_P99_MS / 1_000))} are waiting at a time; slow at ${n(50)} ms, ~${n((API_RPS / API_SERVERS) * 0.05)}.`
);
