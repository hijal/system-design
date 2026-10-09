import { DEPS, run, type Dep, type Fault, type Outcome } from './deps';
import { asWritten, designed, JOURNEYS, type Handlers, type Journey } from './journeys';
import { exponential, heading, mulberry32, n, pct, row } from './random';

const YEARS = Number(process.env.YEARS ?? 10);
const SEED = Number(process.env.SEED ?? 103);
const MINUTES_PER_YEAR = 525_600;

const AVAILABILITY: Record<Dep, { target: number; meanOutage: number }> = {
	'pg-primary': { target: 0.9995, meanOutage: 15 },
	'pg-replica': { target: 0.999, meanOutage: 30 },
	'redis-cache': { target: 0.999, meanOutage: 20 },
	'redis-limiter': { target: 0.999, meanOutage: 20 },
	'redis-queue': { target: 0.999, meanOutage: 20 },
	billing: { target: 0.999, meanOutage: 20 },
	flags: { target: 0.995, meanOutage: 45 },
	'object-storage': { target: 0.9999, meanOutage: 30 },
	email: { target: 0.995, meanOutage: 60 }
};

const COLUMN = 12;

function cell(outcome: Outcome): string {
	const slow = outcome.elapsed > 1_000 ? `${(outcome.elapsed / 1_000).toFixed(1)}s` : '';
	if (outcome.kind === 'ok') return slow || '✓';
	if (outcome.kind === 'degraded') return `~${slow}`;
	return `${outcome.afterCommit ? '✗!' : '✗'}${slow}`;
}

function matrix(title: string, handlers: Handlers, fault: Fault): void {
	heading(title);
	console.log(
		row([
			[fault === 'down' ? 'dead dependency' : 'slow dependency', 18],
			...JOURNEYS.map((j): [string, number] => [j, COLUMN])
		])
	);
	for (const dep of DEPS) {
		const faults = new Map<Dep, Fault>([[dep, fault]]);
		console.log(
			row([
				[dep, 18],
				...JOURNEYS.map((journey): [string, number] => [
					cell(run(handlers[journey], faults)),
					COLUMN
				])
			])
		);
	}
	const healthy = new Map<Dep, Fault>();
	console.log(
		row([
			['(all healthy)', 18],
			...JOURNEYS.map((journey): [string, number] => [
				`${run(handlers[journey], healthy).elapsed} ms`,
				COLUMN
			])
		])
	);
}

function hardDeps(handler: Handlers[Journey]): Dep[] {
	return DEPS.filter((dep) => run(handler, new Map<Dep, Fault>([[dep, 'down']])).kind === 'failed');
}

function outageTimeline(): Uint16Array {
	const random = mulberry32(SEED);
	const minutes = MINUTES_PER_YEAR * YEARS;
	const mask = new Uint16Array(minutes);
	DEPS.forEach((dep, bit) => {
		const { target, meanOutage } = AVAILABILITY[dep];
		const meanUp = (meanOutage * target) / (1 - target);
		let t = exponential(random, meanUp);
		while (t < minutes) {
			const end = Math.min(minutes, t + Math.max(1, exponential(random, meanOutage)));
			for (let m = Math.floor(t); m < end; m++) mask[m] = (mask[m] ?? 0) | (1 << bit);
			t = end + exponential(random, meanUp);
		}
	});
	return mask;
}

type Tally = { ok: number; degraded: number; failed: number };

function availability(): void {
	heading(
		`D. ${YEARS} years of simulated outages (each dependency dies independently) - how long each journey worked`
	);
	const timeline = outageTimeline();
	const depDown = DEPS.map(() => 0);
	const tallies = new Map<string, Tally>();
	const memo = new Map<number, Map<string, Outcome['kind']>>();
	for (const mask of timeline) {
		let outcomes = memo.get(mask);
		if (!outcomes) {
			const faults = new Map<Dep, Fault>();
			DEPS.forEach((dep, bit) => {
				if (mask & (1 << bit)) faults.set(dep, 'down');
			});
			outcomes = new Map();
			for (const journey of JOURNEYS) {
				outcomes.set(`w:${journey}`, run(asWritten[journey], faults).kind);
				outcomes.set(`d:${journey}`, run(designed[journey], faults).kind);
			}
			memo.set(mask, outcomes);
		}
		DEPS.forEach((_, bit) => {
			if (mask & (1 << bit)) depDown[bit] = (depDown[bit] ?? 0) + 1;
		});
		for (const [key, kind] of outcomes) {
			const tally = tallies.get(key) ?? { ok: 0, degraded: 0, failed: 0 };
			tally[kind] += 1;
			tallies.set(key, tally);
		}
	}
	const total = timeline.length;
	console.log(
		row([
			['dependency', 18],
			['target', 10],
			['simulated', 12]
		])
	);
	DEPS.forEach((dep, bit) => {
		console.log(
			row([
				[dep, 18],
				[`${(AVAILABILITY[dep].target * 100).toFixed(2)}%`, 10],
				[pct(total - (depDown[bit] ?? 0), total, 3), 12]
			])
		);
	});
	console.log('');
	console.log(
		row([
			['journey', 13],
			['hard dep (old)', 16],
			['formula', 10],
			['old code', 11],
			['down/year', 11],
			['hard dep (new)', 17],
			['worked', 10],
			['in full', 10],
			['down/year', 11]
		])
	);
	const minutesPerYear = (failed: number): string => `${n(failed / YEARS)} min`;
	for (const journey of JOURNEYS) {
		const before = tallies.get(`w:${journey}`) ?? { ok: 0, degraded: 0, failed: 0 };
		const after = tallies.get(`d:${journey}`) ?? { ok: 0, degraded: 0, failed: 0 };
		const hardBefore = hardDeps(asWritten[journey]);
		const formula = hardBefore.reduce((product, dep) => product * AVAILABILITY[dep].target, 1);
		console.log(
			row([
				[journey, 13],
				[hardBefore.length, 16],
				[`${(formula * 100).toFixed(3)}%`, 10],
				[pct(before.ok + before.degraded, total, 3), 11],
				[minutesPerYear(before.failed), 11],
				[hardDeps(designed[journey]).length, 17],
				[pct(after.ok + after.degraded, total, 3), 10],
				[pct(after.ok, total, 3), 10],
				[minutesPerYear(after.failed), 11]
			])
		);
	}
	console.log(
		`   "formula" = the product of the availabilities of the old code's hard dependencies; "worked" = including degraded, "in full" = with nothing left out`
	);
}

console.log(
	`TaskFlow - ${JOURNEYS.length} user journeys, ${DEPS.length} dependencies. ✓ = fine, ~ = worked with something left out, ✗ = failed, ✗! = written but the user saw an error, Ns = took this many seconds`
);
matrix('A. One dependency dead (connection refused) - old code', asWritten, 'down');
matrix('B. One dependency dead - code written with degradation in mind', designed, 'down');
matrix('C. One dependency slow (answers in 3 s) - old code', asWritten, 'slow');
matrix('C2. One dependency slow - new code (a timeout on every call)', designed, 'slow');
availability();
