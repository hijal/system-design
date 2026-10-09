import {
	ACCOUNTS,
	ALPHA,
	CAP,
	edgesAbove,
	followersAtQuantile,
	followersAtRank,
	MEAN_FOLLOWS,
	totalEdges
} from './graph';
import { big, bytes, env, heading, n, pct, row } from './util';

const DAU = env('DAU', 300_000_000);
const OPENS = env('OPENS', 10);
const POSTS_PER_ACCOUNT = env('POSTS_PER_ACCOUNT', 0.1);
const PEAK = env('PEAK', 3);
const ACTIVE_SHARE = env('ACTIVE_SHARE', 0.4);
const TIMELINE_CAP = env('TIMELINE_CAP', 800);
const ENTRY_BYTES = env('ENTRY_BYTES', 16);
const FANOUT_CAPACITY = env('FANOUT_CAPACITY', 2_000_000);

const DAY = 86_400;
const edges = totalEdges();

heading(
	`Part A - the follower distribution: ${big(ACCOUNTS)} accounts, following ${MEAN_FOLLOWS} on average, power law (α = ${ALPHA}), max ${big(CAP)}`
);
console.log(
	row([
		['', 44],
		['follower', 16]
	])
);
for (const [label, q] of [
	['median account (p50)', 0.5],
	['p90', 0.9],
	['p99', 0.99],
	['p99.99', 0.9999]
] as const)
	console.log(
		row([
			[label, 44],
			[n(followersAtQuantile(q)), 16]
		])
	);
console.log(
	row([
		['biggest account', 44],
		[n(followersAtRank(1)), 16]
	])
);
for (const top of [0.0001, 0.01]) {
	const threshold = followersAtRank(Math.max(1, Math.round(top * ACCOUNTS)));
	const share = edgesAbove(threshold).edges / edges;
	console.log(
		`the top ${top * 100}% of accounts (${n(top * ACCOUNTS)}) hold ${pct(share, 1, 1)} of all follows`
	);
}

const reads = (DAU * OPENS) / DAY;
const posts = (ACCOUNTS * POSTS_PER_ACCOUNT) / DAY;
heading(
	`Part B - traffic: ${big(DAU)} DAU open the feed ${OPENS} times a day; ${POSTS_PER_ACCOUNT} posts a day per account`
);
console.log(
	row([
		['', 44],
		['average/s', 14],
		['peak/s', 14]
	])
);
console.log(
	row([
		['feed reads', 44],
		[n(reads), 14],
		[n(reads * PEAK), 14]
	])
);
console.log(
	row([
		['new posts', 44],
		[n(posts), 14],
		[n(posts * PEAK), 14]
	])
);

heading(
	`Part C - three paths (${Math.round(ACTIVE_SHARE * 100)}% of followers active; ${TIMELINE_CAP} ids × ${ENTRY_BYTES} B in a timeline)`
);
console.log(
	row([
		['path', 40],
		['timeline writes/s', 19],
		['biggest post', 16],
		['fetch per read', 16],
		['fetch/s (peak)', 16],
		['cache', 10]
	])
);
const perPostWrites = (threshold: number, activeOnly: boolean): number =>
	((edges - edgesAbove(threshold).edges) * POSTS_PER_ACCOUNT * (activeOnly ? ACTIVE_SHARE : 1)) /
	DAY;
const cache = bytes(DAU * TIMELINE_CAP * ENTRY_BYTES);
const strategies: [string, number, number, number, string][] = [
	[
		'fan-out on write (push to everyone)',
		perPostWrites(Number.POSITIVE_INFINITY, false),
		followersAtRank(1),
		1,
		cache
	],
	[
		'push, active followers only',
		perPostWrites(Number.POSITIVE_INFINITY, true),
		followersAtRank(1) * ACTIVE_SHARE,
		1,
		cache
	],
	['fan-out on read (pull from everyone)', 0, 0, MEAN_FOLLOWS, '-']
];
for (const threshold of [1_000_000, 100_000, 10_000]) {
	const celeb = edgesAbove(threshold);
	strategies.push([
		`hybrid: over ${n(threshold)} → pull`,
		perPostWrites(threshold, true),
		threshold * ACTIVE_SHARE,
		1 + celeb.edges / ACCOUNTS,
		cache
	]);
}
for (const [name, writes, biggest, fetches, mem] of strategies) {
	console.log(
		row([
			[name, 40],
			[n(writes), 19],
			[n(biggest), 16],
			[fetches.toFixed(1), 16],
			[n(fetches * reads * PEAK), 16],
			[mem, 10]
		])
	);
}
for (const threshold of [1_000_000, 100_000, 10_000]) {
	const celeb = edgesAbove(threshold);
	console.log(
		`over ${n(threshold)} followers: ${n(celeb.accounts)} accounts, ${pct(celeb.edges, edges, 1)} of all follows`
	);
}

heading(
	`Part D - the biggest account posted once, total fan-out capacity ${n(FANOUT_CAPACITY)} writes/s`
);
const top = followersAtRank(1);
console.log(
	`push to everyone: ${n(top)} writes → ${(top / FANOUT_CAPACITY).toFixed(0)} s at full capacity; active only: ${((top * ACTIVE_SHARE) / FANOUT_CAPACITY).toFixed(0)} s.`
);
console.log(
	"meanwhile everyone else's posts in the same queue wait behind it - see `npm run fanout`."
);
