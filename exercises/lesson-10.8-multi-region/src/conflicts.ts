import { REGIONS, USERS, regionRtt, type Region } from './geo';
import { env, heading, lognormal, ms, mulberry32, n, pct, percentile, row } from './util';

const SESSIONS = env('SESSIONS', 20_000);
const BACKGROUND_EDITS = env('BACKGROUND_EDITS', 800_000);
const CROSS_REGION = env('CROSS_REGION', 0.3);
const INCIDENT_LAG_S = env('INCIDENT_LAG_S', 20);
const FRANKFURT_SKEW_MS = env('FRANKFURT_SKEW_MS', -250);
const SEED = env('SEED', 1_081);

const DAY = 86_400_000;
const INCIDENT_START = 14 * 3_600_000;
const INCIDENT_END = 16 * 3_600_000;
const SKEW: Record<Region, number> = {
	singapore: 0,
	mumbai: 40,
	frankfurt: FRANKFURT_SKEW_MS,
	virginia: 10
};
const FIELDS = ['status', 'assignee', 'title', 'description', 'due'] as const;
const FIELD_WEIGHTS = [0.4, 0.2, 0.15, 0.15, 0.1];
type Field = (typeof FIELDS)[number];

type Edit = { id: number; task: number; at: number; region: Region; field: Field; home: Region };

const random = mulberry32(SEED);
const pickRegion = (): Region => {
	let r = random();
	for (const u of USERS) {
		if (r < u.share) return u.nearest;
		r -= u.share;
	}
	return 'singapore';
};
const pickField = (): Field => {
	let r = random();
	for (let i = 0; i < FIELDS.length; i++) {
		const w = FIELD_WEIGHTS[i] ?? 0;
		if (r < w) return FIELDS[i] ?? 'status';
		r -= w;
	}
	return 'status';
};

const edits: Edit[] = [];
let id = 0;
for (let s = 0; s < SESSIONS; s++) {
	const start = random() * (DAY - 300_000);
	const home = pickRegion();
	const cross = random() < CROSS_REGION;
	const people = 2 + Math.floor(random() * 3);
	const regions: Region[] = Array.from({ length: people }, (_, k) =>
		k === 0 || !cross ? home : (REGIONS[Math.floor(random() * REGIONS.length)] ?? home)
	);
	const count = 5 + Math.floor(random() * 11);
	for (let e = 0; e < count; e++) {
		edits.push({
			id: id++,
			task: s,
			at: start + random() * 180_000,
			region: regions[Math.floor(random() * regions.length)] ?? home,
			field: pickField(),
			home
		});
	}
}
const totalEdits = edits.length + BACKGROUND_EDITS;

const delays = new Map<string, number>();
const delay = (a: Edit, b: Edit): number => {
	const key = `${a.id}>${b.region}`;
	const cached = delays.get(key);
	if (cached !== undefined) return cached;
	const inIncident = a.at >= INCIDENT_START && a.at < INCIDENT_END;
	const base = regionRtt(a.region, b.region) / 2 + 50;
	const value = inIncident
		? lognormal(random, INCIDENT_LAG_S * 1_000, 0.5)
		: lognormal(random, base, 0.4);
	delays.set(key, value);
	return value;
};

type Policy = { name: string; scope: 'row' | 'field'; clock: 'wall' | 'hlc' };
const POLICIES: Policy[] = [
	{ name: 'LWW, পুরো row, wall clock', scope: 'row', clock: 'wall' },
	{ name: 'LWW, field ধরে, wall clock', scope: 'field', clock: 'wall' },
	{ name: 'LWW, field ধরে, HLC', scope: 'field', clock: 'hlc' }
];

const byTask = new Map<number, Edit[]>();
for (const e of edits) {
	const list = byTask.get(e.task) ?? [];
	list.push(e);
	byTask.set(e.task, list);
}
for (const list of byTask.values()) list.sort((a, b) => a.at - b.at);

heading(
	`অংশ ক — এক দিন: ${n(totalEdits)} edit (${n(edits.length)}টা ${n(SESSIONS)}টা যৌথ session এ, ${Math.round(CROSS_REGION * 100)}% session এ অন্য region এর মানুষ); প্রতিটা region এ লেখা নেওয়া হয়`
);
console.log(
	`replication: সাধারণত region এর দূরত্বের অর্ধেক + ৫০ ms; ১৪:০০–১৬:০০ link খারাপ, median ${INCIDENT_LAG_S} s; ফ্রাঙ্কফুর্টের ঘড়ি ${FRANKFURT_SKEW_MS} ms\n`
);
console.log(
	row([
		['নিয়ম', 30],
		['নীরবে হারানো edit', 18],
		['মোটের %', 10],
		['একসাথে (concurrent)', 20],
		['ঘড়ির জন্য উল্টো', 18],
		['২ ঘণ্টার incident এ', 20]
	])
);
for (const policy of POLICIES) {
	const lost = new Set<number>();
	let concurrentLost = 0;
	let skewLost = 0;
	let incidentLost = 0;
	for (const list of byTask.values()) {
		for (let i = 0; i < list.length; i++) {
			const a = list[i];
			if (!a) continue;
			for (let j = i + 1; j < list.length; j++) {
				const b = list[j];
				if (!b || b.at - a.at > 120_000) break;
				if (a.region === b.region) continue;
				if (policy.scope === 'field' && a.field !== b.field) continue;
				const concurrent = b.at < a.at + delay(a, b);
				const tsA = a.at + SKEW[a.region];
				const tsB = b.at + SKEW[b.region];
				let loser: Edit | null = null;
				if (concurrent) loser = tsA > tsB ? b : a;
				else if (policy.clock === 'wall' && tsB < tsA) loser = b;
				if (!loser || lost.has(loser.id)) continue;
				lost.add(loser.id);
				if (concurrent) concurrentLost++;
				else skewLost++;
				if (loser.at >= INCIDENT_START && loser.at < INCIDENT_END) incidentLost++;
			}
		}
	}
	console.log(
		row([
			[policy.name, 30],
			[n(lost.size), 18],
			[pct(lost.size, totalEdits, 3), 10],
			[n(concurrentLost), 20],
			[n(skewLost), 18],
			[n(incidentLost), 20]
		])
	);
}
console.log(
	row([
		['workspace এর home region এ লেখা', 30],
		['0', 18],
		['0%', 10],
		['0', 20],
		['0', 18],
		['0', 20]
	])
);

heading('অংশ খ — home region এর দাম: অন্য region থেকে আসা edit কে home এ যেতে হয়');
const extra: number[] = [];
let away = 0;
for (const e of edits) {
	if (e.region === e.home) continue;
	away++;
	extra.push(regionRtt(e.region, e.home) * lognormal(random, 1, 0.15));
}
extra.sort((a, b) => a - b);
console.log(
	row([
		['session এর edit অন্য region থেকে', 36],
		[`${n(away)} (${pct(away, edits.length, 1)})`, 20]
	])
);
console.log(
	row([
		['তাদের বাড়তি latency p50', 36],
		[ms(percentile(extra, 50)), 20]
	])
);
console.log(
	row([
		['তাদের বাড়তি latency p95', 36],
		[ms(percentile(extra, 95)), 20]
	])
);
console.log(
	row([
		['সব edit এর মধ্যে বাড়তি পায়', 36],
		[pct(away, totalEdits, 2), 20]
	])
);
