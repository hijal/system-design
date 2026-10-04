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
	`অংশ ক — follower এর বণ্টন: ${big(ACCOUNTS)} account, গড়ে ${MEAN_FOLLOWS} জনকে follow, power law (α = ${ALPHA}), সর্বোচ্চ ${big(CAP)}`
);
console.log(
	row([
		['', 44],
		['follower', 16]
	])
);
for (const [label, q] of [
	['মাঝের account (p50)', 0.5],
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
		['সবচেয়ে বড় account', 44],
		[n(followersAtRank(1)), 16]
	])
);
for (const top of [0.0001, 0.01]) {
	const threshold = followersAtRank(Math.max(1, Math.round(top * ACCOUNTS)));
	const share = edgesAbove(threshold).edges / edges;
	console.log(
		`উপরের ${top * 100}% account (${n(top * ACCOUNTS)}টা) এর কাছে সব follow এর ${pct(share, 1, 1)}`
	);
}

const reads = (DAU * OPENS) / DAY;
const posts = (ACCOUNTS * POSTS_PER_ACCOUNT) / DAY;
heading(
	`অংশ খ — traffic: ${big(DAU)} DAU দিনে ${OPENS} বার feed খোলে; account প্রতি দিনে ${POSTS_PER_ACCOUNT}টা post`
);
console.log(
	row([
		['', 44],
		['গড়/s', 14],
		['peak/s', 14]
	])
);
console.log(
	row([
		['feed পড়া', 44],
		[n(reads), 14],
		[n(reads * PEAK), 14]
	])
);
console.log(
	row([
		['নতুন post', 44],
		[n(posts), 14],
		[n(posts * PEAK), 14]
	])
);

heading(
	`অংশ গ — তিনটা পথ (follower এর ${Math.round(ACTIVE_SHARE * 100)}% সক্রিয়; timeline এ ${TIMELINE_CAP}টা id × ${ENTRY_BYTES} B)`
);
console.log(
	row([
		['পথ', 40],
		['timeline লেখা/s', 17],
		['সবচেয়ে বড় post', 16],
		['পড়ায় fetch', 12],
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
		'fan-out on write (সবাইকে push)',
		perPostWrites(Number.POSITIVE_INFINITY, false),
		followersAtRank(1),
		1,
		cache
	],
	[
		'push, শুধু সক্রিয় follower',
		perPostWrites(Number.POSITIVE_INFINITY, true),
		followersAtRank(1) * ACTIVE_SHARE,
		1,
		cache
	],
	['fan-out on read (সবার থেকে pull)', 0, 0, MEAN_FOLLOWS, '—']
];
for (const threshold of [1_000_000, 100_000, 10_000]) {
	const celeb = edgesAbove(threshold);
	strategies.push([
		`hybrid: ${n(threshold)} এর বেশি → pull`,
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
			[n(writes), 17],
			[n(biggest), 16],
			[fetches.toFixed(1), 12],
			[n(fetches * reads * PEAK), 16],
			[mem, 10]
		])
	);
}
for (const threshold of [1_000_000, 100_000, 10_000]) {
	const celeb = edgesAbove(threshold);
	console.log(
		`${n(threshold)} এর বেশি follower: ${n(celeb.accounts)}টা account, সব follow এর ${pct(celeb.edges, edges, 1)}`
	);
}

heading(
	`অংশ ঘ — সবচেয়ে বড় account একটা post করল, fan-out এর মোট ক্ষমতা ${n(FANOUT_CAPACITY)} লেখা/s`
);
const top = followersAtRank(1);
console.log(
	`সবাইকে push: ${n(top)}টা লেখা → পুরো ক্ষমতায় ${(top / FANOUT_CAPACITY).toFixed(0)} s; শুধু সক্রিয়দের: ${((top * ACTIVE_SHARE) / FANOUT_CAPACITY).toFixed(0)} s।`
);
console.log('এই সময় একই queue তে থাকা বাকি সবার post পেছনে অপেক্ষা করে — `npm run fanout` দেখো।');
