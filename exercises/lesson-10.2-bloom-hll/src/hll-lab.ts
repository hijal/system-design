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
		`ক. একটা HyperLogLog (p = ${PRECISION}, ${n(sketch.memoryBytes())} byte) এ একই user বারবার — আসল সংখ্যা বনাম অনুমান`
	);
	console.log(
		row([
			['আলাদা user', 14],
			['অনুমান', 14],
			['ভুল', 10],
			['correction ছাড়া', 18],
			['ভুল', 13],
			['সঠিক গুনতে ≥', 15]
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
		`   "সঠিক গুনতে ≥" = প্রতিটা user এর শুধু একটা 8-byte hash রাখলেও যত memory লাগত (আসল Set এ আরও বেশি)`
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
		`খ. Precision বদলালে — ${n(count)} জন আলাদা user, ${TRIALS}টা আলাদা দিন (আলাদা user সেট), প্রতি দিনের অনুমানের ভুল`
	);
	console.log(
		row([
			['p', 5],
			['register', 11],
			['memory', 11],
			['তত্ত্ব (1.04/√m)', 18],
			['মাপা সাধারণ ভুল', 17],
			['সবচেয়ে খারাপ দিন', 18]
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
	console.log('   (সাধারণ ভুল = RMS; প্রায় ৯৫% দিনে ভুল তার দ্বিগুণের মধ্যে থাকার কথা)');
}

function weekly(): void {
	heading(
		'গ. TaskFlow এর ৭ দিন: প্রতিদিন ~২ লাখ active, তার ১.৫ লাখ নিয়মিত — সপ্তাহে আলাদা user কতজন?'
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
			['পদ্ধতি', 34],
			['সপ্তাহের user', 16],
			['ভুল', 12]
		])
	);
	const cases: [string, number][] = [
		['আসল (সব ID এর একটা Set)', truth],
		['৭টা দিনের সংখ্যা যোগ', sumOfDaily],
		['৭টা HLL merge (register ধরে max)', merged.count()]
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
		`   প্রতিটা দিনের HLL ${n(days[0]?.memoryBytes() ?? 0)} byte; merge এর পরেও একই আকার — আর ৩০ দিন merge করলেও`
	);
}

function intersection(): void {
	const size = 1_000_000;
	heading(
		`ঘ. দুটো workspace, প্রত্যেকে ${n(size)} viewer — দুটোতেই কতজন? (|A∩B| = |A| + |B| − |A∪B|)`
	);
	console.log(
		row([
			['আসল overlap', 14],
			['আসল দুটোতেই', 14],
			['HLL দিয়ে', 14],
			['ভুল', 12]
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
		'   (union ~২০ লাখ, তার ~0.8% ভুল ≈ ১৬,০০০ — পুরোটা গিয়ে পড়ে ছোট intersection এর উপর)'
	);
}

accuracy();
precisionSweep();
weekly();
intersection();
