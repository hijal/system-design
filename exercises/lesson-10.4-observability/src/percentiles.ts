import { heading, lognormal, ms, mulberry32, n, pct, percentile, row } from './random';

const RPS = Number(process.env.RPS ?? 300);
const MINUTES = Number(process.env.MINUTES ?? 60);
const STALL_SECONDS = Number(process.env.STALL_SECONDS ?? 90);
const SEED = Number(process.env.SEED ?? 41);
const STALLS = [12, 31, 47];
const INSTANCES = 6;
const REPLICAS = 3;

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const TUNED_BUCKETS = [50, 75, 100, 150, 200, 300, 500, 1_000, 2_000, 3_000, 4_000, 5_000];

type Request = { at: number; instance: number; replica: number; latency: number };

function simulate(): Request[] {
	const random = mulberry32(SEED);
	const requests: Request[] = [];
	const total = RPS * MINUTES * 60;
	for (let i = 0; i < total; i++) {
		const at = i / RPS;
		const replica = Math.floor(random() * REPLICAS);
		let latency = lognormal(random, 70, 0.4) + lognormal(random, 8, 0.3);
		const minute = at / 60;
		const stalled = STALLS.some((start) => minute >= start && minute < start + STALL_SECONDS / 60);
		if (stalled && replica === REPLICAS - 1) latency += 2_500 + random() * 2_000;
		requests.push({ at, instance: i % INSTANCES, replica, latency });
	}
	return requests;
}

const sorted = (values: number[]): number[] => [...values].sort((a, b) => a - b);
const mean = (values: number[]): number =>
	values.reduce((sum, value) => sum + value, 0) / values.length;

function histogramQuantile(q: number, bounds: number[], latencies: number[]): number {
	const counts = bounds.map(() => 0);
	let overflow = 0;
	for (const latency of latencies) {
		const index = bounds.findIndex((bound) => latency <= bound);
		if (index === -1) overflow++;
		else counts[index] = (counts[index] ?? 0) + 1;
	}
	const rank = q * latencies.length;
	let cumulative = 0;
	for (let i = 0; i < bounds.length; i++) {
		const count = counts[i] ?? 0;
		if (cumulative + count >= rank) {
			const lower = i === 0 ? 0 : (bounds[i - 1] ?? 0);
			const upper = bounds[i] ?? 0;
			return lower + ((upper - lower) * (rank - cumulative)) / Math.max(1, count);
		}
		cumulative += count;
	}
	return overflow > 0 ? (bounds[bounds.length - 1] ?? 0) : 0;
}

const requests = simulate();
const all = sorted(requests.map((request) => request.latency));

heading(
	`ক. এক ঘণ্টার board খোলা — ${n(requests.length)} request, ${INSTANCES}টা instance, ${REPLICAS}টা replica; r${REPLICAS} এর disk ঘণ্টায় ${STALLS.length}বার ${STALL_SECONDS} s আটকে যায়`
);
console.log(
	row([
		['গড়', 10],
		['p50', 10],
		['p90', 10],
		['p99', 10],
		['p99.9', 10],
		['max', 10],
		['> 1 s', 10]
	])
);
console.log(
	row([
		[ms(mean(all)), 10],
		[ms(percentile(all, 50)), 10],
		[ms(percentile(all, 90)), 10],
		[ms(percentile(all, 99)), 10],
		[ms(percentile(all, 99.9)), 10],
		[ms(all[all.length - 1] ?? 0), 10],
		[pct(all.filter((latency) => latency > 1_000).length, all.length, 2), 10]
	])
);

heading('খ. Dashboard এর rollup — প্রতি মিনিটের p99 থেকে ঘণ্টার সংখ্যা বানালে');
const perMinute: number[][] = Array.from({ length: MINUTES }, () => []);
for (const request of requests) perMinute[Math.floor(request.at / 60)]?.push(request.latency);
const minuteP99 = perMinute.map((values) => percentile(sorted(values), 99));
const minuteAvg = perMinute.map((values) => mean(values));
console.log(
	row([
		['ঘণ্টার সংখ্যা', 34],
		['মান', 12]
	])
);
console.log(
	row([
		['আসল p99 (সব request একসাথে)', 34],
		[ms(percentile(all, 99)), 12]
	])
);
console.log(
	row([
		['৬০টা মিনিটের p99 এর গড়', 34],
		[ms(mean(minuteP99)), 12]
	])
);
console.log(
	row([
		['৬০টা মিনিটের p99 এর median', 34],
		[ms(percentile(sorted(minuteP99), 50)), 12]
	])
);
console.log(
	row([
		['৬০টা মিনিটের p99 এর max', 34],
		[ms(Math.max(...minuteP99)), 12]
	])
);
console.log(
	row([
		['৬০টা মিনিটের গড়ের গড়', 34],
		[ms(mean(minuteAvg)), 12]
	])
);
console.log('');
console.log(
	row([
		['মিনিট', 8],
		['গড়', 10],
		['p99', 10],
		['> 1 s', 10]
	])
);
for (const minute of [10, 11, 12, 13, 14, 30, 31, 32]) {
	const values = perMinute[minute] ?? [];
	console.log(
		row([
			[minute, 8],
			[ms(minuteAvg[minute] ?? 0), 10],
			[ms(minuteP99[minute] ?? 0), 10],
			[pct(values.filter((latency) => latency > 1_000).length, values.length, 1), 10]
		])
	);
}

heading('গ. Histogram থেকে percentile — bucket এর সীমা কোথায়, তার উপর অনুমান');
console.log(
	row([
		['percentile', 12],
		['আসল', 10],
		['default bucket', 16],
		['ভুল', 9],
		['নিজের bucket', 14],
		['ভুল', 9]
	])
);
for (const q of [50, 90, 99, 99.9]) {
	const truth = percentile(all, q);
	const coarse = histogramQuantile(q / 100, DEFAULT_BUCKETS, all);
	const tuned = histogramQuantile(q / 100, TUNED_BUCKETS, all);
	const error = (estimate: number): string =>
		`${estimate >= truth ? '+' : ''}${(((estimate - truth) / truth) * 100).toFixed(0)}%`;
	console.log(
		row([
			[`p${q}`, 12],
			[ms(truth), 10],
			[ms(coarse), 16],
			[error(coarse), 9],
			[ms(tuned), 14],
			[error(tuned), 9]
		])
	);
}
console.log(`   default bucket (ms): ${DEFAULT_BUCKETS.join(', ')}`);
console.log(`   নিজের bucket   (ms): ${TUNED_BUCKETS.join(', ')}`);
console.log(
	'   bucket এর গণনা যোগ করা যায় — ৬টা instance এর histogram যোগ করলে ঠিক এক histogram; percentile যোগ বা গড় করা যায় না'
);

heading('ঘ. একই request, আলাদা মাত্রায় ভাগ করে দেখা');
console.log(
	row([
		['মাত্রা', 14],
		['request', 10],
		['গড়', 10],
		['p50', 10],
		['p99', 10],
		['> 1 s', 10]
	])
);
const breakdown = (label: string, filter: (request: Request) => boolean): void => {
	const values = sorted(requests.filter(filter).map((request) => request.latency));
	console.log(
		row([
			[label, 14],
			[n(values.length), 10],
			[ms(mean(values)), 10],
			[ms(percentile(values, 50)), 10],
			[ms(percentile(values, 99)), 10],
			[pct(values.filter((latency) => latency > 1_000).length, values.length, 2), 10]
		])
	);
};
for (let instance = 0; instance < INSTANCES; instance++)
	breakdown(`instance ${instance + 1}`, (request) => request.instance === instance);
for (let replica = 0; replica < REPLICAS; replica++)
	breakdown(`replica r${replica + 1}`, (request) => request.replica === replica);
