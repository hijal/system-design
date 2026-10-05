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
	{ name: 'LWW, whole row, wall clock', scope: 'row', clock: 'wall' },
	{ name: 'LWW, per field, wall clock', scope: 'field', clock: 'wall' },
	{ name: 'LWW, per field, HLC', scope: 'field', clock: 'hlc' }
];

const byTask = new Map<number, Edit[]>();
for (const e of edits) {
	const list = byTask.get(e.task) ?? [];
	list.push(e);
	byTask.set(e.task, list);
}
for (const list of byTask.values()) list.sort((a, b) => a.at - b.at);

heading(
	`Part A — one day: ${n(totalEdits)} edits (${n(edits.length)} in ${n(SESSIONS)} shared sessions, ${Math.round(CROSS_REGION * 100)}% of sessions with people from another region); writes accepted in every region`
);
console.log(
	`replication: normally half the region distance + 50 ms; the link is bad 14:00–16:00, median ${INCIDENT_LAG_S} s; Frankfurt's clock ${FRANKFURT_SKEW_MS} ms\n`
);
console.log(
	row([
		['rule', 40],
		['silently lost edits', 20],
		['% of total', 11],
		['concurrent', 20],
		['reversed by clock', 19],
		['in the 2 h incident', 20]
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
			[policy.name, 40],
			[n(lost.size), 20],
			[pct(lost.size, totalEdits, 3), 11],
			[n(concurrentLost), 20],
			[n(skewLost), 19],
			[n(incidentLost), 20]
		])
	);
}
console.log(
	row([
		["writes to the workspace's home region", 40],
		['0', 18],
		['0%', 10],
		['0', 20],
		['0', 18],
		['0', 20]
	])
);

heading('Part B — the price of home regions: edits from another region have to travel home');
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
		['session edits from another region', 40],
		[`${n(away)} (${pct(away, edits.length, 1)})`, 20]
	])
);
console.log(
	row([
		['their extra latency p50', 40],
		[ms(percentile(extra, 50)), 20]
	])
);
console.log(
	row([
		['their extra latency p95', 40],
		[ms(percentile(extra, 95)), 20]
	])
);
console.log(
	row([
		['share of all edits paying extra', 40],
		[pct(away, totalEdits, 2), 20]
	])
);
