import { CountMinSketch } from './cms';
import { heading, pct, row, zipfSampler } from './random';

const KEYS = Number(process.env.KEYS ?? 200_000);
const REQUESTS = Number(process.env.REQUESTS ?? 2_000_000);
const ZIPF = Number(process.env.ZIPF ?? 1.1);
const DEPTH = Number(process.env.DEPTH ?? 4);
const TOP = 10;

const keyOf = (rank: number): string => `board:${(rank * 7919) % KEYS}`;

function stream(): string[] {
	const sample = zipfSampler(KEYS, ZIPF, 31);
	return Array.from({ length: REQUESTS }, () => keyOf(sample()));
}

function run(width: number, requests: readonly string[], exact: ReadonlyMap<string, number>) {
	const sketch = new CountMinSketch(width, DEPTH);
	const leaders = new Map<string, number>();
	for (const key of requests) {
		sketch.add(key);
		const estimate = sketch.estimate(key);
		if (leaders.has(key) || leaders.size < TOP * 2) {
			leaders.set(key, estimate);
			continue;
		}
		let weakest = '';
		let weakestValue = Number.POSITIVE_INFINITY;
		for (const [candidate, value] of leaders)
			if (value < weakestValue) {
				weakest = candidate;
				weakestValue = value;
			}
		if (estimate > weakestValue) {
			leaders.delete(weakest);
			leaders.set(key, estimate);
		}
	}
	const trueTop = [...exact.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, TOP)
		.map(([key]) => key);
	const found = [...leaders.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, TOP)
		.map(([key]) => key);
	const recall = found.filter((key) => trueTop.includes(key)).length;
	let topError = 0;
	for (const key of trueTop) {
		const truth = exact.get(key) ?? 1;
		topError = Math.max(topError, (sketch.estimate(key) - truth) / truth);
	}
	let tailTruth = 0;
	let tailEstimate = 0;
	for (const [key, truth] of exact)
		if (truth <= 5) {
			tailTruth += truth;
			tailEstimate += sketch.estimate(key);
		}
	return { sketch, recall, topError, tailRatio: tailEstimate / tailTruth };
}

function main(): void {
	const requests = stream();
	const exact = new Map<string, number>();
	for (const key of requests) exact.set(key, (exact.get(key) ?? 0) + 1);
	let hottest = 0;
	for (const count of exact.values()) hottest = Math.max(hottest, count);
	heading(
		`${REQUESTS.toLocaleString('en-US')} requests, ${exact.size.toLocaleString('en-US')} distinct boards, Zipf ${ZIPF} — the hottest board alone is ${pct(hottest, REQUESTS, 1)}`
	);
	console.log(
		row([
			['width × depth', 16],
			['memory', 10],
			['top 10 hit', 12],
			['top 10 overcount', 21],
			['cold boards (≤5 times)', 24]
		])
	);
	for (const width of [64, 256, 1024, 4096, 16384]) {
		const { sketch, recall, topError, tailRatio } = run(width, requests, exact);
		console.log(
			row([
				[`${width} × ${DEPTH}`, 16],
				[`${Math.round(sketch.memoryBytes() / 1024)} KB`, 10],
				[`${recall}/${TOP}`, 12],
				[`≤ ${pct(topError, 1, 2)}`, 21],
				[`${tailRatio.toFixed(1)}x actual`, 24]
			])
		);
	}
	console.log(
		`   exact count: a Map of ${exact.size.toLocaleString('en-US')} keys; the sketch never undercounts, only overcounts`
	);
}

main();
