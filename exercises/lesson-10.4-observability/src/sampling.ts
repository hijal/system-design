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
	{ name: 'সব রাখো', kind: 'head', rate: 1 },
	{ name: 'head ১০%', kind: 'head', rate: 0.1 },
	{ name: 'head ১%', kind: 'head', rate: 0.01 },
	{ name: 'head ০.১%', kind: 'head', rate: 0.001 },
	{ name: 'tail: error + ধীর + ১%', kind: 'tail', rate: 0.01 },
	{ name: 'tail: error + ধীর + ০.১%', kind: 'tail', rate: 0.001 },
	{ name: 'প্রতি service নিজে ১০%', kind: 'independent', rate: 0.1 }
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
	`ক. একদিনে ${n(total)}টা trace (${RPS} req/s, প্রতিটায় ${SPANS}টা span ≈ ${bytes(traceBytes)}); error ${n(errors)}টা, ১ s এর বেশি ধীর ${n(slow)}টা, আর একটা বিরল bug (একটা workspace) ${n(rare)}বার`
);
console.log(
	row([
		['নীতি', 26],
		['রাখা trace', 12],
		['পুরো trace', 12],
		['error', 10],
		['ধীর', 10],
		['বিরল bug', 10],
		['জমা/দিন', 11],
		['collector এ আসে', 17]
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
	`   "পুরো trace" = রাখা trace এর কত % এ সব ${SERVICES}টা service এর span আছে; error/ধীর/বিরল bug = পুরো trace হিসেবে রাখা`
);
const buffer = RPS * traceBytes * (DECISION_WAIT + 1);
console.log(
	`   tail sampling এ সিদ্ধান্তের আগে প্রতিটা trace collector এর memory তে ~${DECISION_WAIT} s অপেক্ষা করে: যেকোনো মুহূর্তে ~${bytes(buffer)}`
);

heading(
	`খ. বিরল bug টার একটা পুরো trace হাতে থাকার সম্ভাবনা — দিনে ${RARE_PER_DAY}বার ঘটে, head sampling এর হার বদলে`
);
console.log(
	row([
		['head হার', 12],
		['১ দিনে', 10],
		['১ সপ্তাহে', 12]
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
