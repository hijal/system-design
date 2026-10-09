import { HyperLogLog, standardError } from './hll';
import { heading, mulberry32, pct, row } from './random';

const PRECISION = Number(process.env.PRECISION ?? 14);
const TRIALS = Number(process.env.TRIALS ?? 40);
const MAX = Number(process.env.MAX ?? 10_000_000);

const n = (value: number): string => Math.round(value).toLocaleString('en-US');
const signed = (estimate: number, truth: number): string => {
	const error = ((estimate - truth) / truth) * 100;
	return `${error >= 0 ? '+' : ''}${error.toFixed(2)}%`;
};

const bytes = (value: number): string => (value < 1024 ? `${n(value)} B` : `${n(value / 1024)} KB`);

function sketchOf(prefix: string, count: number, precision = PRECISION): HyperLogLog {
	const sketch = new HyperLogLog(precision);
	for (let i = 0; i < count; i++) sketch.add(`${prefix}:${i}`);
	return sketch;
}

function accuracy(): void {
	const sketch = new HyperLogLog(PRECISION);
	heading(
		`A. One HyperLogLog (p = ${PRECISION}, ${n(sketch.memoryBytes())} bytes) seeing the same users again and again - real count vs estimate`
	);
	console.log(
		row([
			['real users', 14],
			['estimate', 14],
			['error', 10],
			['no correction', 18],
			['error', 13],
			['exact needs ≥', 15]
		])
	);
	const checkpoints = [10, 100, 1_000, 10_000, 30_000, 50_000, 100_000, 1_000_000, 10_000_000];
	let added = 0;
	for (const target of checkpoints.filter((value) => value <= MAX)) {
		for (; added < target; added++) {
			sketch.add(`user:${added}`);
			if (added % 3 === 0) sketch.add(`user:${added}`);
		}
		const { value, raw } = sketch.estimate();
		console.log(
			row([
				[n(target), 14],
				[n(value), 14],
				[signed(value, target), 10],
				[n(raw), 18],
				[signed(raw, target), 13],
				[bytes(target * 8), 15]
			])
		);
	}
	console.log(
		`   "exact needs ≥" = the memory needed even if only one 8-byte hash per user were kept (a real Set takes more)`
	);
}

function spread(precision: number, count: number): { typical: number; worst: number } {
	let squares = 0;
	let worst = 0;
	for (let trial = 0; trial < TRIALS; trial++) {
		const estimate = sketchOf(`t${trial}`, count, precision).count();
		const error = (estimate - count) / count;
		squares += error * error;
		worst = Math.max(worst, Math.abs(error));
	}
	return { typical: Math.sqrt(squares / TRIALS), worst };
}

function precisionSweep(): void {
	const count = 100_000;
	heading(
		`B. Changing the precision - ${n(count)} distinct users, ${TRIALS} different days (different user sets), each day's estimate error`
	);
	console.log(
		row([
			['p', 5],
			['register', 11],
			['memory', 11],
			['theory (1.04/√m)', 18],
			['measured RMS', 17],
			['worst day', 18]
		])
	);
	for (const precision of [4, 6, 8, 10, 12, 14, 16]) {
		const { typical, worst } = spread(precision, count);
		const registers = 1 << precision;
		console.log(
			row([
				[precision, 5],
				[n(registers), 11],
				[`${n((registers * 6) / 8)} B`, 11],
				[pct(standardError(precision), 1, 2), 18],
				[pct(typical, 1, 2), 17],
				[pct(worst, 1, 2), 18]
			])
		);
	}
	console.log(
		'   (RMS = the typical error; on about 95% of days the error should be within twice that)'
	);
}

function weekly(): void {
	heading(
		"C. TaskFlow's 7 days: ~200k active each day, 150k of them regulars - how many distinct users in the week?"
	);
	const random = mulberry32(21);
	const regulars = 150_000;
	const population = 2_000_000;
	const days: HyperLogLog[] = [];
	const exactDays: number[] = [];
	const weekExact = new Set<number>();
	for (let day = 0; day < 7; day++) {
		const sketch = new HyperLogLog(PRECISION);
		const seen = new Set<number>();
		for (let user = 0; user < regulars; user++) seen.add(user);
		while (seen.size < 200_000) seen.add(regulars + Math.floor(random() * (population - regulars)));
		for (const user of seen) {
			sketch.add(`user:${user}`);
			weekExact.add(user);
		}
		days.push(sketch);
		exactDays.push(seen.size);
	}
	const merged = days.reduce((left, right) => left.merge(right));
	const sumOfDaily = days.reduce((total, sketch) => total + sketch.count(), 0);
	const truth = weekExact.size;
	console.log(
		row([
			['approach', 34],
			['weekly users', 16],
			['error', 12]
		])
	);
	const cases: [string, number][] = [
		['exact (a Set of every ID)', truth],
		['sum of the 7 daily counts', sumOfDaily],
		['merge 7 HLLs (max per register)', merged.count()]
	];
	for (const [label, value] of cases)
		console.log(
			row([
				[label, 34],
				[n(value), 16],
				[signed(value, truth), 12]
			])
		);
	console.log(
		`   each day's HLL is ${n(days[0]?.memoryBytes() ?? 0)} bytes; still the same size after merging - even merging 30 days`
	);
}

function intersection(): void {
	const size = 1_000_000;
	heading(
		`D. Two workspaces, ${n(size)} viewers each - how many in both? (|A∩B| = |A| + |B| − |A∪B|)`
	);
	console.log(
		row([
			['real overlap', 14],
			['real in both', 14],
			['with HLL', 14],
			['error', 12]
		])
	);
	for (const overlap of [0.5, 0.1, 0.01, 0.001]) {
		const shared = Math.round(size * overlap);
		const a = new HyperLogLog(PRECISION);
		const b = new HyperLogLog(PRECISION);
		for (let i = 0; i < size; i++) a.add(`viewer:${i}`);
		for (let i = size - shared; i < 2 * size - shared; i++) b.add(`viewer:${i}`);
		const estimate = a.count() + b.count() - a.merge(b).count();
		console.log(
			row([
				[pct(overlap, 1, 1), 14],
				[n(shared), 14],
				[n(estimate), 14],
				[signed(estimate, shared), 12]
			])
		);
	}
	console.log(
		'   (the union is ~2 million, ~0.8% of it ≈ 16,000 - all of it lands on the small intersection)'
	);
}

accuracy();
precisionSweep();
weekly();
intersection();
