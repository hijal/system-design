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
const READS = env('READS', 20_000);
const FETCH_MS = env('FETCH_MS', 2);
const SLOW_SHARE = env('SLOW_SHARE', 0.01);
const SLOW_MS = env('SLOW_MS', 50);
const HEDGE_AFTER_MS = env('HEDGE_AFTER_MS', 10);
const SESSIONS = env('SESSIONS', 20_000);
const PAGE = env('PAGE', 20);
const NEW_PER_MIN = env('NEW_PER_MIN', 2);
const READ_S = env('READ_S', 30);
const DELETE_SHARE = env('DELETE_SHARE', 0.02);

heading(
	`Part A — fetching from K places at once in one feed read: each median ${FETCH_MS} ms, ${SLOW_SHARE * 100}% slow (${SLOW_MS} ms)`
);
console.log(
	row([
		['path', 52],
		['K', 6],
		['p50', 10],
		['p99', 10],
		['at least one slow', 19]
	])
);
const fetchOnce = (random: () => number): number =>
	random() < SLOW_SHARE
		? SLOW_MS + lognormal(random, FETCH_MS, 0.3)
		: lognormal(random, FETCH_MS, 0.4);
const cases: [string, number, boolean][] = [
	['push: your own timeline only', 1, false],
	['hybrid: timeline + ~19 celebrities', 20, false],
	['hybrid, slow ones hedged (second try at 10 ms)', 20, true],
	['pull: posts from all 200', 200, false],
	['pull, with hedging', 200, true]
];
for (const [name, k, hedge] of cases) {
	const random = mulberry32(SEED);
	const latencies: number[] = [];
	let anySlow = 0;
	for (let r = 0; r < READS; r++) {
		let worst = 0;
		let slow = false;
		for (let i = 0; i < k; i++) {
			let t = fetchOnce(random);
			if (t > SLOW_MS) slow = true;
			if (hedge && t > HEDGE_AFTER_MS) t = Math.min(t, HEDGE_AFTER_MS + fetchOnce(random));
			worst = Math.max(worst, t);
		}
		if (slow) anySlow++;
		latencies.push(worst);
	}
	latencies.sort((a, b) => a - b);
	console.log(
		row([
			[name, 52],
			[k, 6],
			[ms(percentile(latencies, 50)), 10],
			[ms(percentile(latencies, 99)), 10],
			[pct(anySlow, READS, 1), 19]
		])
	);
}

heading(
	`Part B — the second page: ${NEW_PER_MIN} new posts a minute in the feed, ${READ_S} s on average to read a page, ${DELETE_SHARE * 100}% of the first page deleted`
);
console.log(
	row([
		['how the page works', 40],
		['already seen on page 2', 24],
		['one skipped', 16]
	])
);
for (const mode of ['offset', 'cursor'] as const) {
	const random = mulberry32(SEED + 9);
	let duplicates = 0;
	let skipped = 0;
	for (let s = 0; s < SESSIONS; s++) {
		const feed = Array.from({ length: 200 }, (_, i) => 10_000 - i);
		const page1 = feed.slice(0, PAGE);
		const wait = exponential(random, READ_S);
		let added = 0;
		for (
			let t = exponential(random, 60 / NEW_PER_MIN);
			t < wait;
			t += exponential(random, 60 / NEW_PER_MIN)
		)
			added++;
		const removed = page1.filter(() => random() < DELETE_SHARE);
		const now = [
			...Array.from({ length: added }, (_, i) => 20_000 + added - i),
			...feed.filter((id) => !removed.includes(id))
		];
		const lastSeen = page1[page1.length - 1] ?? 0;
		const page2 =
			mode === 'offset'
				? now.slice(PAGE, PAGE * 2)
				: now.filter((id) => id < lastSeen).slice(0, PAGE);
		const seen = new Set(page1);
		if (page2.some((id) => seen.has(id))) duplicates++;
		const expectedFirst = feed[PAGE] ?? 0;
		if (!page2.includes(expectedFirst)) skipped++;
	}
	console.log(
		row([
			[
				mode === 'offset'
					? '?offset=20 (skip the first 20)'
					: '?cursor=<last seen id> (id < cursor)',
				40
			],
			[pct(duplicates, SESSIONS, 1), 24],
			[pct(skipped, SESSIONS, 1), 16]
		])
	);
}
console.log(
	`\n${n(SESSIONS)} sessions. "one skipped" = the post right after the first page did not appear on the second page.`
);
