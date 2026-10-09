import { z } from 'zod';
import { mulberry32, percentile } from './random';
import { Sim } from './sim';

// Lesson 7.4 §1.4 - Poison messages and the Dead Letter Queue: four policies, the same 5 minutes.
//
//   • 20 email jobs per second for 300 s (6000); 4 workers; a good job takes 100 ms
//   • 2% of jobs are "poison": something wrong in the data (like an invalid address) - each time it works 2 s, then the provider returns 400.
//     It will never succeed.
//   • a provider outage at 60–90 s: every request gets 503 in 50 ms - temporary, it will recover.
//   • at 400 s, after the outage, a human looks at the DLQ and "redrives": every job back into the queue.
//
// Seeded - exactly the same every time. Can be changed with SEED.

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
	// what happens if this attempt fails: retry after how long (ms), or to the DLQ
	onFail: (attempt: number, kind: ErrorKind) => number | 'dlq';
}

const expo = (attempt: number, cap: number): number => Math.min(cap, 1000 * 2 ** (attempt - 1));

const policies: Policy[] = [
	{ name: 'retry forever (no limit)', onFail: (n) => expo(n, 30_000) },
	{ name: '5 times, then DLQ', onFail: (n) => (n >= 5 ? 'dlq' : expo(n, 30_000)) },
	{
		name: '5 times; permanent to DLQ at once',
		onFail: (n, kind) => (kind === 'permanent' || n >= 5 ? 'dlq' : expo(n, 30_000))
	},
	{
		name: 'permanent at once; transient 12 times',
		// 1, 2, 4 … 32, then 60 s - ~7 minutes of attempts in total: long enough to cover an outage
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
			// Poison's fault is in the data - outage or not, 2 s of work, then 400
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

	// a human looked at the DLQ: set the poison ones aside (the data needs fixing), everything else back into the queue
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
	`\n   ${(DURATION / 1000) * RATE} jobs (${RATE}/s), ${WORKERS} workers · 2% poison (${fmt(POISON_MS)} each time, then 400) · outage ${OUTAGE.from / 1000}–${OUTAGE.to / 1000} s (503) · redrive at ${REDRIVE_AT / 1000} s\n`
);
console.log(
	'   policy                                  poison worker time     max waiting  good delay p99       to DLQ (good / poison) redriven → arrived   pending (good / poison)'
);
for (const policy of policies) {
	const r = run(policy);
	console.log(
		`   ${policy.name.padEnd(38)}${pct(r.poisonWorkMs, r.totalWorkMs).padStart(20)}${String(r.peakWaiting).padStart(16)}${fmt(percentile(r.goodDelays, 99)).padStart(16)}${`${r.dlqGood} / ${r.dlqPoison}`.padStart(29)}${`${r.redriven} → ${r.deliveredAfterRedrive}`.padStart(19)}${`${r.pendingGood} / ${r.pendingPoison}`.padStart(26)}`
	);
}
console.log(
	'\n   (every good job should arrive; "pending" = still waiting or waiting for a retry at 600 s)'
);
