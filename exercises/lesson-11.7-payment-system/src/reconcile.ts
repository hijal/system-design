import { env, heading, mulberry32, n, pct, row } from './util';

const SEED = env('SEED', 11);
const PAYMENTS = env('PAYMENTS', 1_000_000);
const OFFSET_H = env('OFFSET_H', 6);
const MISSED_WEBHOOK = env('MISSED_WEBHOOK', 0.0002);
const NEVER_CAPTURED = env('NEVER_CAPTURED', 0.0001);
const AMOUNT_DIFF = env('AMOUNT_DIFF', 0.00005);
const DUPLICATE = env('DUPLICATE', 0.00003);

type Kind = 'ok' | 'missed-webhook' | 'never-captured' | 'amount' | 'duplicate';

interface Ours {
	id: number;
	day: number;
	amount: number;
	status: 'succeeded' | 'failed';
}

interface Theirs {
	ref: number;
	day: number;
	amount: number;
}

const random = mulberry32(SEED);
const ours: Ours[] = [];
const theirs: Theirs[] = [];
const truth = new Map<number, Kind>();
for (let id = 0; id < PAYMENTS * 3; id++) {
	const day = Math.floor(id / PAYMENTS);
	const hour = random() * 24;
	const theirDay = day + (hour < OFFSET_H ? -1 : 0);
	const amount = 100 + Math.floor(random() * 9_900);
	const r = random();
	let kind: Kind = 'ok';
	if (r < MISSED_WEBHOOK) kind = 'missed-webhook';
	else if (r < MISSED_WEBHOOK + NEVER_CAPTURED) kind = 'never-captured';
	else if (r < MISSED_WEBHOOK + NEVER_CAPTURED + AMOUNT_DIFF) kind = 'amount';
	else if (r < MISSED_WEBHOOK + NEVER_CAPTURED + AMOUNT_DIFF + DUPLICATE) kind = 'duplicate';
	truth.set(id, kind);
	ours.push({ id, day, amount, status: kind === 'missed-webhook' ? 'failed' : 'succeeded' });
	if (kind !== 'never-captured')
		theirs.push({ ref: id, day: theirDay, amount: kind === 'amount' ? amount - 1 : amount });
	if (kind === 'duplicate') theirs.push({ ref: id, day: theirDay, amount });
}

const DAY = 1;
const realProblems = [...truth.entries()].filter(
	([id, k]) => k !== 'ok' && Math.floor(id / PAYMENTS) === DAY
).length;

type Strategy = { name: string; run: () => Set<number> };

const oursOn = (d: number): Ours[] => ours.filter((o) => o.day === d && o.status === 'succeeded');
const oursFailedOn = (d: number): Ours[] =>
	ours.filter((o) => o.day === d && o.status === 'failed');
const theirsOn = (d: number): Theirs[] => theirs.filter((t) => t.day === d);

const byId = (window: number): Set<number> => {
	const flagged = new Set<number>();
	const theirsIn = theirs.filter((t) => t.day >= DAY - window && t.day <= DAY + window);
	const counts = new Map<number, Theirs[]>();
	for (const t of theirsIn) counts.set(t.ref, [...(counts.get(t.ref) ?? []), t]);
	for (const o of oursOn(DAY)) {
		const match = counts.get(o.id) ?? [];
		if (match.length !== 1 || match[0]?.amount !== o.amount) flagged.add(o.id);
	}
	for (const o of oursFailedOn(DAY)) if ((counts.get(o.id) ?? []).length > 0) flagged.add(o.id);
	if (window === 0)
		for (const t of theirsOn(DAY)) if (Math.floor(t.ref / PAYMENTS) !== DAY) flagged.add(t.ref);
	return flagged;
};

const strategies: Strategy[] = [
	{
		name: 'একই তারিখ, শুধু amount মিলিয়ে',
		run: () => {
			const flagged = new Set<number>();
			const pool = new Map<number, number[]>();
			for (const t of theirsOn(DAY)) pool.set(t.amount, [...(pool.get(t.amount) ?? []), t.ref]);
			for (const o of oursOn(DAY)) {
				const list = pool.get(o.amount);
				const got = list?.shift();
				if (got === undefined) flagged.add(o.id);
			}
			for (const [, rest] of pool) for (const ref of rest) flagged.add(ref);
			return flagged;
		}
	},
	{ name: 'আমাদের payment id (PSP এর reference এ), একই তারিখ', run: () => byId(0) },
	{ name: 'payment id, ±১ দিনের জানালা', run: () => byId(1) }
];

heading(
	`${n(PAYMENTS)}টা payment এর একটা দিন; PSP এর দিন আমাদের থেকে ${OFFSET_H} ঘণ্টা আগে শুরু হয় (UTC বনাম UTC+${OFFSET_H}); আসল সমস্যা: ${n(realProblems)}টা`
);
console.log(
	row([
		['মেলানোর নিয়ম', 50],
		['alert', 10],
		['আসল', 10],
		['মিথ্যা alert', 13],
		['আসল, ধরা পড়েনি', 16]
	])
);
for (const s of strategies) {
	const flagged = s.run();
	let real = 0;
	for (const id of flagged) if (truth.get(id) !== 'ok' && Math.floor(id / PAYMENTS) === DAY) real++;
	console.log(
		row([
			[s.name, 50],
			[n(flagged.size), 10],
			[n(real), 10],
			[n(flagged.size - real), 13],
			[`${n(realProblems - real)} (${pct(realProblems - real, realProblems, 0)})`, 16]
		])
	);
}
console.log(
	'\nআসল সমস্যার ধরন: webhook হারিয়েছে (আমরা ব্যর্থ ভাবছি, PSP কেটেছে), capture কখনো যায়নি, amount এ অমিল, PSP তে দুবার কাটা।'
);
