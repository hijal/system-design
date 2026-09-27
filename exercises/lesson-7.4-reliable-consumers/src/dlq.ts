import { z } from 'zod';
import { mulberry32, percentile } from './random';
import { Sim } from './sim';

// Lesson 7.4 §১.৪ — Poison message আর Dead Letter Queue: চারটা নীতি, একই ৫ মিনিট।
//
//   • প্রতি সেকেন্ডে 20টা email job, 300 s ধরে (6000টা); worker 4টা; ভালো job এ 100 ms লাগে
//   • 2% job "poison": data তে গোলমাল (যেমন অবৈধ address) — প্রতিবার 2 s কাজ করে তারপর provider 400 দেয়।
//     কখনো সফল হবে না।
//   • 60–90 s provider এর outage: সব request 50 ms এ 503 — সাময়িক, সেরে যাবে।
//   • 400 s এ outage এর পরে একজন মানুষ DLQ দেখে "redrive" করে: সব job আবার queue তে।
//
// Seed দেওয়া — প্রতিবার হুবহু একই। SEED দিয়ে বদলানো যায়।

const env = z.object({ SEED: z.coerce.number().int().default(7) }).parse(process.env);

const RATE = 20;
const DURATION = 300_000;
const WORKERS = 4;
const GOOD_MS = 100;
const POISON_MS = 2000;
const FAST_FAIL_MS = 50;
const OUTAGE = { from: 60_000, to: 90_000 };
const REDRIVE_AT = 400_000;
const END = 600_000;

type ErrorKind = 'transient' | 'permanent';

interface Policy {
	name: string;
	// এই চেষ্টা ব্যর্থ হলে কী হবে: কত পরে আবার (ms), নাকি DLQ তে
	onFail: (attempt: number, kind: ErrorKind) => number | 'dlq';
}

const expo = (attempt: number, cap: number): number => Math.min(cap, 1000 * 2 ** (attempt - 1));

const policies: Policy[] = [
	{ name: 'সারাজীবন retry (সীমা নেই)', onFail: (n) => expo(n, 30_000) },
	{ name: '৫ বার, তারপর DLQ', onFail: (n) => (n >= 5 ? 'dlq' : expo(n, 30_000)) },
	{
		name: '৫ বার; permanent সাথে সাথে DLQ',
		onFail: (n, kind) => (kind === 'permanent' || n >= 5 ? 'dlq' : expo(n, 30_000))
	},
	{
		name: 'permanent সাথে সাথে; transient ১২ বার',
		// 1, 2, 4 … 32, তারপর 60 s — মোট ~৭ মিনিট চেষ্টা: outage ঢাকার মতো লম্বা
		onFail: (n, kind) => (kind === 'permanent' || n >= 12 ? 'dlq' : expo(n, 60_000))
	}
];

interface Job {
	id: number;
	poison: boolean;
	arrivedAt: number;
	attempt: number;
}

interface Result {
	delivered: number;
	goodTotal: number;
	dlqGood: number;
	dlqPoison: number;
	pendingGood: number;
	pendingPoison: number;
	poisonWorkMs: number;
	totalWorkMs: number;
	peakWaiting: number;
	goodDelays: number[];
	redriven: number;
	deliveredAfterRedrive: number;
}

function run(policy: Policy): Result {
	const sim = new Sim();
	const random = mulberry32(env.SEED);
	const waiting: Job[] = [];
	const dlq: Job[] = [];
	let busy = 0;
	const r: Result = {
		delivered: 0,
		goodTotal: 0,
		dlqGood: 0,
		dlqPoison: 0,
		pendingGood: 0,
		pendingPoison: 0,
		poisonWorkMs: 0,
		totalWorkMs: 0,
		peakWaiting: 0,
		goodDelays: [],
		redriven: 0,
		deliveredAfterRedrive: 0
	};
	const delayed = new Set<Job>();

	const pump = (): void => {
		while (busy < WORKERS) {
			const job = waiting.shift();
			if (!job) return;
			busy++;
			const outage = sim.now >= OUTAGE.from && sim.now < OUTAGE.to;
			// Poison এর দোষ data তে — outage থাকুক বা না থাকুক, 2 s কাজ তারপর 400
			const ms = job.poison ? POISON_MS : outage ? FAST_FAIL_MS : GOOD_MS;
			const ok = !job.poison && !outage;
			const kind: ErrorKind = job.poison ? 'permanent' : 'transient';
			r.totalWorkMs += ms;
			if (job.poison) r.poisonWorkMs += ms;
			sim.after(ms, () => {
				busy--;
				if (ok) {
					r.delivered++;
					if (sim.now >= REDRIVE_AT) r.deliveredAfterRedrive++;
					r.goodDelays.push(sim.now - job.arrivedAt);
				} else {
					const next = policy.onFail(job.attempt, kind);
					if (next === 'dlq') {
						dlq.push(job);
						if (job.poison) r.dlqPoison++;
						else r.dlqGood++;
					} else {
						delayed.add(job);
						sim.after(next, () => {
							delayed.delete(job);
							job.attempt++;
							waiting.push(job);
							pump();
						});
					}
				}
				pump();
			});
		}
	};

	let id = 0;
	for (let t = 0; t < DURATION; t += 1000 / RATE) {
		sim.at(t, () => {
			const poison = random() < 0.02;
			if (!poison) r.goodTotal++;
			waiting.push({ id: id++, poison, arrivedAt: sim.now, attempt: 1 });
			r.peakWaiting = Math.max(r.peakWaiting, waiting.length);
			pump();
		});
	}
	for (let t = 0; t < END; t += 1000)
		sim.at(t, () => (r.peakWaiting = Math.max(r.peakWaiting, waiting.length)));

	// মানুষ DLQ দেখল: poison গুলো আলাদা করে সরিয়ে রাখল (ঠিক করতে হবে data), বাকি সব আবার queue তে
	sim.at(REDRIVE_AT, () => {
		const again = dlq.filter((j) => !j.poison);
		dlq.splice(0, dlq.length, ...dlq.filter((j) => j.poison));
		for (const job of again) {
			job.attempt = 1;
			waiting.push(job);
		}
		r.redriven = again.length;
		pump();
	});

	sim.run(END);
	const pending = [...waiting, ...delayed];
	r.pendingGood = pending.filter((j) => !j.poison).length;
	r.pendingPoison = pending.filter((j) => j.poison).length;
	return r;
}

const fmt = (ms: number): string =>
	ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const pct = (a: number, b: number): string => `${Math.round((a / Math.max(1, b)) * 100)}%`;

console.log(
	`\n   ${(DURATION / 1000) * RATE} টা job (${RATE}/s), ${WORKERS} worker · 2% poison (প্রতিবার ${fmt(POISON_MS)} তারপর 400) · outage ${OUTAGE.from / 1000}–${OUTAGE.to / 1000} s (503) · redrive ${REDRIVE_AT / 1000} s এ\n`
);
console.log(
	'   নীতি                                   worker সময় poison এ   সর্বোচ্চ লাইন   ভালো দেরি p99   DLQ তে গেল (ভালো / poison)   redrive → পৌঁছাল   শেষে বাকি (ভালো / poison)'
);
for (const policy of policies) {
	const r = run(policy);
	console.log(
		`   ${policy.name.padEnd(38)}${pct(r.poisonWorkMs, r.totalWorkMs).padStart(20)}${String(r.peakWaiting).padStart(16)}${fmt(percentile(r.goodDelays, 99)).padStart(16)}${`${r.dlqGood} / ${r.dlqPoison}`.padStart(29)}${`${r.redriven} → ${r.deliveredAfterRedrive}`.padStart(19)}${`${r.pendingGood} / ${r.pendingPoison}`.padStart(26)}`
	);
}
console.log(
	'\n   (ভালো job মোট পৌঁছানোর কথা; "শেষে বাকি" = 600 s এ তখনো waiting বা retry এর অপেক্ষায়)'
);
