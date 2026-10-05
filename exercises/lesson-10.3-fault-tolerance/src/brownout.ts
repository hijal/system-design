import { exponential, heading, ms, mulberry32, n, pct, percentile, row } from './random';

const WORKERS = Number(process.env.WORKERS ?? 48);
const BASE_RPS = Number(process.env.BASE_RPS ?? 600);
const PEAK = Number(process.env.PEAK ?? 2.5);
const CLIENT_TIMEOUT = Number(process.env.CLIENT_TIMEOUT ?? 3_000);
const SHED_WAIT = Number(process.env.SHED_WAIT ?? 300);
const BROWNOUT_WAIT = Number(process.env.BROWNOUT_WAIT ?? 50);
const SEED = Number(process.env.SEED ?? 11);

const PARTS = [
	{ name: 'task list', cost: 8 },
	{ name: 'comment counts', cost: 5 },
	{ name: 'activity panel', cost: 12 },
	{ name: '"more boards like this"', cost: 25 }
] as const;

const COST_AT_LEVEL = [0, 1, 2, 3].map((level) =>
	PARTS.slice(0, PARTS.length - level).reduce((sum, part) => sum + part.cost, 0)
);

const SPIKE_FROM = 4 * 60_000;
const SPIKE_TO = 11 * 60_000;
const DURATION = 15 * 60_000;

function rpsAt(t: number): number {
	const minute = t / 60_000;
	const peak = BASE_RPS * PEAK;
	if (minute < 3) return BASE_RPS;
	if (minute < 4) return BASE_RPS + (peak - BASE_RPS) * (minute - 3);
	if (minute < 11) return peak;
	if (minute < 12) return peak - (peak - BASE_RPS) * (minute - 11);
	return BASE_RPS;
}

function arrivals(): Float64Array {
	const random = mulberry32(SEED);
	const peak = BASE_RPS * PEAK;
	const times: number[] = [];
	let t = 0;
	while (t < DURATION) {
		t += exponential(random, 1_000 / peak);
		if (random() < rpsAt(t) / peak) times.push(t);
	}
	return Float64Array.from(times);
}

type Policy = { name: string; deadline: boolean; shed: boolean; brownout: boolean };

const POLICIES: Policy[] = [
	{ name: 'nothing', deadline: false, shed: false, brownout: false },
	{ name: '+ deadline check', deadline: true, shed: false, brownout: false },
	{ name: 'load shedding (7.4)', deadline: true, shed: true, brownout: false },
	{ name: 'brownout', deadline: true, shed: false, brownout: true },
	{ name: 'brownout + shedding', deadline: true, shed: true, brownout: true }
];

class MinHeap {
	private readonly items: number[];

	constructor(size: number) {
		this.items = Array.from({ length: size }, () => 0);
	}

	peek(): number {
		return this.items[0] ?? 0;
	}

	replaceTop(value: number): void {
		const items = this.items;
		items[0] = value;
		let i = 0;
		for (;;) {
			const left = 2 * i + 1;
			const right = left + 1;
			let smallest = i;
			if (left < items.length && (items[left] ?? 0) < (items[smallest] ?? 0)) smallest = left;
			if (right < items.length && (items[right] ?? 0) < (items[smallest] ?? 0)) smallest = right;
			if (smallest === i) return;
			const swap = items[i] ?? 0;
			items[i] = items[smallest] ?? 0;
			items[smallest] = swap;
			i = smallest;
		}
	}
}

type Minute = { arrived: number; served: number; levelSum: number; latencies: number[] };

type Result = {
	total: number;
	served: number;
	full: number;
	shed: number;
	timedOut: number;
	latencies: number[];
	wasted: number;
	work: number;
	minutes: Minute[];
	lastLate: number;
};

function simulate(policy: Policy, times: Float64Array): Result {
	const random = mulberry32(SEED + 1);
	const workers = new MinHeap(WORKERS);
	const result: Result = {
		total: 0,
		served: 0,
		full: 0,
		shed: 0,
		timedOut: 0,
		latencies: [],
		wasted: 0,
		work: 0,
		lastLate: 0,
		minutes: Array.from({ length: DURATION / 60_000 }, () => ({
			arrived: 0,
			served: 0,
			levelSum: 0,
			latencies: []
		}))
	};
	let level = 0;
	let second = 0;
	let waitSum = 0;
	let waitCount = 0;
	let calm = 0;
	for (const arrival of times) {
		const minute = result.minutes[Math.floor(arrival / 60_000)];
		const inSpike = arrival >= SPIKE_FROM && arrival < SPIKE_TO;
		if (minute) minute.arrived++;
		const start = Math.max(arrival, workers.peek());
		while (policy.brownout && start >= (second + 1) * 1_000) {
			const meanWait = waitCount === 0 ? 0 : waitSum / waitCount;
			if (meanWait > BROWNOUT_WAIT) {
				level = Math.min(3, level + 1);
				calm = 0;
			} else if (meanWait < BROWNOUT_WAIT / 10 && level > 0 && ++calm >= 10) {
				level--;
				calm = 0;
			}
			waitSum = 0;
			waitCount = 0;
			second++;
		}
		const wait = start - arrival;
		if (inSpike) result.total++;
		if (policy.shed && wait > SHED_WAIT) {
			if (inSpike) result.shed++;
			result.lastLate = arrival;
			continue;
		}
		if (policy.deadline && wait + (COST_AT_LEVEL[level] ?? 0) > CLIENT_TIMEOUT) {
			if (inSpike) result.timedOut++;
			result.lastLate = arrival;
			continue;
		}
		waitSum += wait;
		waitCount++;
		const cost = (COST_AT_LEVEL[level] ?? 0) * (0.5 + random());
		const finish = start + cost;
		workers.replaceTop(finish);
		const latency = finish - arrival;
		const inTime = latency <= CLIENT_TIMEOUT;
		if (!inTime) result.lastLate = arrival;
		if (minute) {
			minute.levelSum += level;
			if (inTime) {
				minute.served++;
				minute.latencies.push(latency);
			}
		}
		if (!inSpike) continue;
		result.work += cost;
		if (!inTime) {
			result.timedOut++;
			result.wasted += cost;
			continue;
		}
		result.served++;
		if (level === 0) result.full++;
		result.latencies.push(latency);
	}
	for (const minute of result.minutes) minute.latencies.sort((a, b) => a - b);
	result.latencies.sort((a, b) => a - b);
	return result;
}

function recovery(lastLate: number): string {
	const after = lastLate - 12 * 60_000;
	if (lastLate >= DURATION - 1_000) return 'not even in 15 minutes';
	if (after <= 0) return 'immediately';
	return `${(after / 1_000).toFixed(0)} s`;
}

const times = arrivals();
const fullCapacity = (WORKERS * 1_000) / (COST_AT_LEVEL[0] ?? 1);
heading(
	`A. Opening a board — ${WORKERS} workers, normally ${BASE_RPS} req/s, ${PEAK}× at 9 am (${n(BASE_RPS * PEAK)} req/s) for 7 minutes; the client leaves after ${CLIENT_TIMEOUT / 1_000} s`
);
console.log(
	`   full page = ${PARTS.map((part) => `${part.name} ${part.cost} ms`).join(' + ')} = ${COST_AT_LEVEL[0]} ms of worker time`
);
console.log(
	`   capacity: ${n(fullCapacity)} req/s with the full page; at the brownout levels ${COST_AT_LEVEL.slice(
		1
	)
		.map((cost) => `${cost} ms → ${n((WORKERS * 1_000) / cost)} req/s`)
		.join(', ')}`
);
console.log(
	'   the numbers below are only for requests arriving in the 7 minutes of load (minute 4 to 11):'
);
console.log(
	row([
		['policy', 22],
		['got board', 11],
		['full page', 11],
		['503', 9],
		['timeout', 10],
		['p50', 10],
		['p99', 10],
		['wasted work', 12],
		['recovery after load', 21]
	])
);
const results = POLICIES.map((policy) => ({ policy, result: simulate(policy, times) }));
for (const { policy, result } of results) {
	console.log(
		row([
			[policy.name, 22],
			[pct(result.served, result.total), 11],
			[pct(result.full, result.total), 11],
			[pct(result.shed, result.total), 9],
			[pct(result.timedOut, result.total), 10],
			[result.latencies.length ? ms(percentile(result.latencies, 50)) : '—', 10],
			[result.latencies.length ? ms(percentile(result.latencies, 99)) : '—', 10],
			[pct(result.wasted, result.work), 12],
			[recovery(result.lastLate), 21]
		])
	);
}
console.log(
	`   "wasted work" = worker time spent on requests whose client had already left, as % of total worker time; "recovery after load" = how long after traffic returned to normal (minute 12) someone last failed to get a timely answer`
);

heading('B. By the minute — how the brownout level moves (0 = full page, 3 = task list only)');
const brownout = results.find(({ policy }) => policy.name === 'brownout')?.result;
const nothing = results[0]?.result;
console.log(
	row([
		['minute', 8],
		['req/s', 8],
		['avg level', 10],
		['brownout p99', 14],
		['nothing: p99', 14],
		['nothing: on time', 17]
	])
);
for (let m = 0; m < DURATION / 60_000; m++) {
	const b = brownout?.minutes[m];
	const x = nothing?.minutes[m];
	if (!b || !x) continue;
	console.log(
		row([
			[m, 8],
			[n(b.arrived / 60), 8],
			[(b.levelSum / Math.max(1, b.arrived)).toFixed(2), 10],
			[ms(percentile(b.latencies, 99)), 14],
			[x.latencies.length ? ms(percentile(x.latencies, 99)) : '—', 14],
			[pct(x.served, x.arrived), 17]
		])
	);
}
