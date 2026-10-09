import { bytes, heading, mulberry32, n, pct, row } from './random';

const RPS = Number(process.env.RPS ?? 300);
const ERROR = Number(process.env.ERROR ?? 0.0005);
const SLOW = Number(process.env.SLOW ?? 0.005);
const RARE_PER_DAY = Number(process.env.RARE_PER_DAY ?? 40);
const SERVICES = Number(process.env.SERVICES ?? 5);
const SPANS = Number(process.env.SPANS ?? 20);
const SPAN_BYTES = Number(process.env.SPAN_BYTES ?? 400);
const DECISION_WAIT = Number(process.env.DECISION_WAIT ?? 10);
const SEED = Number(process.env.SEED ?? 23);

type Policy =
	| { name: string; kind: 'head'; rate: number }
	| { name: string; kind: 'independent'; rate: number }
	| { name: string; kind: 'tail'; rate: number };

const POLICIES: Policy[] = [
	{ name: 'keep all', kind: 'head', rate: 1 },
	{ name: 'head 10%', kind: 'head', rate: 0.1 },
	{ name: 'head 1%', kind: 'head', rate: 0.01 },
	{ name: 'head 0.1%', kind: 'head', rate: 0.001 },
	{ name: 'tail: error + slow + 1%', kind: 'tail', rate: 0.01 },
	{ name: 'tail: error + slow + 0.1%', kind: 'tail', rate: 0.001 },
	{ name: 'each service its own 10%', kind: 'independent', rate: 0.1 }
];

type Tally = {
	kept: number;
	complete: number;
	errors: number;
	slow: number;
	rare: number;
	ingested: number;
};

const total = RPS * 86_400;
const traceBytes = SPANS * SPAN_BYTES;
const random = mulberry32(SEED);
const tallies: Tally[] = POLICIES.map(() => ({
	kept: 0,
	complete: 0,
	errors: 0,
	slow: 0,
	rare: 0,
	ingested: 0
}));
let errors = 0;
let slow = 0;
let rare = 0;
const rareRate = RARE_PER_DAY / total;
for (let i = 0; i < total; i++) {
	const isRare = random() < rareRate;
	const isError = isRare || random() < ERROR;
	const isSlow = random() < SLOW;
	if (isError) errors++;
	if (isSlow) slow++;
	if (isRare) rare++;
	const roll = random();
	POLICIES.forEach((policy, index) => {
		const tally = tallies[index];
		if (!tally) return;
		let keep: boolean;
		let complete = true;
		if (policy.kind === 'head') {
			keep = roll < policy.rate;
			tally.ingested += keep ? traceBytes : 0;
		} else if (policy.kind === 'tail') {
			keep = isError || isSlow || roll < policy.rate;
			tally.ingested += traceBytes;
		} else {
			let services = 0;
			for (let s = 0; s < SERVICES; s++) if (random() < policy.rate) services++;
			keep = services > 0;
			complete = services === SERVICES;
			tally.ingested += (traceBytes * services) / SERVICES;
		}
		if (!keep) return;
		tally.kept++;
		if (complete) tally.complete++;
		if (isError && complete) tally.errors++;
		if (isSlow && complete) tally.slow++;
		if (isRare && complete) tally.rare++;
	});
}

heading(
	`A. ${n(total)} traces in a day (${RPS} req/s, ${SPANS} spans each ≈ ${bytes(traceBytes)}); ${n(errors)} errors, ${n(slow)} slower than 1 s, and one rare bug (one workspace) ${n(rare)} times`
);
console.log(
	row([
		['policy', 26],
		['traces kept', 12],
		['full trace', 12],
		['error', 10],
		['slow', 10],
		['rare bug', 10],
		['stored/day', 11],
		['into collector', 17]
	])
);
POLICIES.forEach((policy, index) => {
	const tally = tallies[index];
	if (!tally) return;
	console.log(
		row([
			[policy.name, 26],
			[n(tally.kept), 12],
			[pct(tally.complete, Math.max(1, tally.kept), 3), 12],
			[`${n(tally.errors)}`, 10],
			[`${n(tally.slow)}`, 10],
			[`${tally.rare}/${rare}`, 10],
			[bytes(tally.complete * traceBytes), 11],
			[bytes(tally.ingested), 17]
		])
	);
});
console.log(
	`   "full trace" = what % of kept traces have spans from all ${SERVICES} services; error/slow/rare bug = kept as a full trace`
);
const buffer = RPS * traceBytes * (DECISION_WAIT + 1);
console.log(
	`   with tail sampling every trace waits ~${DECISION_WAIT} s in the collector's memory before the decision: ~${bytes(buffer)} at any moment`
);

heading(
	`B. The chance of having a full trace of the rare bug - it happens ${RARE_PER_DAY} times a day, varying the head sampling rate`
);
console.log(
	row([
		['head rate', 12],
		['in 1 day', 10],
		['in 1 week', 12]
	])
);
for (const rate of [0.1, 0.01, 0.001, 0.0001]) {
	const day = 1 - Math.pow(1 - rate, RARE_PER_DAY);
	const week = 1 - Math.pow(1 - rate, RARE_PER_DAY * 7);
	console.log(
		row([
			[`${rate * 100}%`, 12],
			[pct(day, 1, 1), 10],
			[pct(week, 1, 1), 12]
		])
	);
}
