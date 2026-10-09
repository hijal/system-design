import { LADDER } from './ladder';
import { env, exponential, heading, lognormal, mulberry32, n, pct, percentile, row } from './util';

const SEED = env('SEED', 11);
const VIDEO_MIN = env('VIDEO_MIN', 60);
const SEGMENT_S = env('SEGMENT_S', 4);
const WORKERS = env('WORKERS', 100);
const INTERRUPT_PER_CPU_H = env('INTERRUPT_PER_CPU_H', 0.2);
const UPLOADS = env('UPLOADS', 40);
const STARTUP_S = env('STARTUP_S', 20);

interface Task {
	rendition: number;
	cpuSeconds: number;
}

interface Result {
	publish: number;
	firstPlayable: number;
	cpu: number;
	wasted: number;
}

function run(tasks: Task[], workers: number, random: () => number, firstRendition: number): Result {
	const free = new Array<number>(workers).fill(STARTUP_S);
	const queue = [...tasks];
	let cpu = 0;
	let wasted = 0;
	let publish = 0;
	const lastOf = new Map<number, number>();
	while (queue.length > 0) {
		const task = queue.shift();
		if (task === undefined) break;
		let w = 0;
		for (let i = 1; i < workers; i++) if ((free[i] ?? 0) < (free[w] ?? 0)) w = i;
		const start = free[w] ?? 0;
		const interruptAfter = exponential(random, 3_600 / INTERRUPT_PER_CPU_H);
		if (interruptAfter < task.cpuSeconds) {
			wasted += interruptAfter;
			cpu += interruptAfter;
			free[w] = start + interruptAfter + STARTUP_S;
			queue.unshift(task);
			continue;
		}
		cpu += task.cpuSeconds;
		const end = start + task.cpuSeconds;
		free[w] = end;
		lastOf.set(task.rendition, Math.max(lastOf.get(task.rendition) ?? 0, end));
		publish = Math.max(publish, end);
	}
	return { publish, firstPlayable: lastOf.get(firstRendition) ?? publish, cpu, wasted };
}

type Plan = {
	name: string;
	workers: number;
	split: 'none' | 'rendition' | 'segment';
	lowFirst: boolean;
};

const plans: Plan[] = [
	{
		name: 'one worker, the whole video, one resolution after another',
		workers: 1,
		split: 'none',
		lowFirst: false
	},
	{
		name: `one worker per resolution (${LADDER.length})`,
		workers: LADDER.length,
		split: 'rendition',
		lowFirst: false
	},
	{
		name: `${SEGMENT_S} s pieces, ${WORKERS} workers`,
		workers: WORKERS,
		split: 'segment',
		lowFirst: false
	},
	{ name: `the same, but 360p pieces first`, workers: WORKERS, split: 'segment', lowFirst: true }
];

heading(
	`${VIDEO_MIN}-minute videos, ${LADDER.length} resolutions (${LADDER.reduce((s, r) => s + r.cpu, 0).toFixed(1)} CPU-hours per hour in total); spot workers, taken back ${INTERRUPT_PER_CPU_H} times per CPU-hour; ${UPLOADS} uploads`
);
console.log(
	row([
		['plan', 58],
		['publish p50', 13],
		['p99', 11],
		['360p watchable', 16],
		['wasted CPU', 12]
	])
);
for (const plan of plans) {
	const random = mulberry32(SEED);
	const publishes: number[] = [];
	const firsts: number[] = [];
	let cpu = 0;
	let wasted = 0;
	for (let u = 0; u < UPLOADS; u++) {
		const segments = Math.ceil((VIDEO_MIN * 60) / SEGMENT_S);
		const tasks: Task[] = [];
		const order = plan.lowFirst ? [1, 0, 2, 3, 4] : [0, 1, 2, 3, 4];
		for (const r of order) {
			const rendition = LADDER[r];
			if (rendition === undefined) continue;
			if (plan.split === 'segment') {
				for (let s = 0; s < segments; s++)
					tasks.push({
						rendition: r,
						cpuSeconds: SEGMENT_S * rendition.cpu * lognormal(random, 1, 0.2)
					});
			} else
				tasks.push({
					rendition: r,
					cpuSeconds: VIDEO_MIN * 60 * rendition.cpu * lognormal(random, 1, 0.05)
				});
		}
		const result = run(tasks, plan.workers, random, 1);
		publishes.push(result.publish);
		firsts.push(result.firstPlayable);
		cpu += result.cpu;
		wasted += result.wasted;
	}
	publishes.sort((a, b) => a - b);
	firsts.sort((a, b) => a - b);
	const show = (s: number): string =>
		s >= 3_600
			? `${(s / 3_600).toFixed(1)} h`
			: s >= 60
				? `${(s / 60).toFixed(1)} min`
				: `${n(s)} s`;
	console.log(
		row([
			[plan.name, 58],
			[show(percentile(publishes, 50)), 13],
			[show(percentile(publishes, 99)), 11],
			[show(percentile(firsts, 50)), 16],
			[pct(wasted, cpu, 2), 12]
		])
	);
}
console.log(
	`\n"360p watchable" = every 360p piece is built, and the video can be opened to viewers. A worker takes ${STARTUP_S} s to start; when taken back, the job runs again - the whole resolution, or just that piece.`
);
