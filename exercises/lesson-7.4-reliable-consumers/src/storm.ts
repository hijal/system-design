import { z } from 'zod';
import { mulberry32, percentile } from './random';
import { Sim } from './sim';

// Lesson 7.4 §1.3 — Retry storm: four retry policies, two situations.
//
//   (a) everyone at once — 1000 jobs at exactly the same moment (the 9 am digest cron, or a backlog released
//       all at once after an outage). The question here: do the failed ones come back together again?
//   (b) outage — jobs arrive spread out (50/s, 20 s), the provider is down for the first OUTAGE_MS.
//
// The provider's model: it can successfully take at most 10 requests per 100 ms (100/s); the extras get
// an immediate 503 — under overload it protects itself (load shedding). Each attempt takes 50 ms to answer.
// Every job is tried at most MAX_ATTEMPTS times.
//
// Seeded — the jitter's randomness is the same every time too. Can be changed with SEED.

const env = z
	.object({
		SEED: z.coerce.number().int().default(7),
		OUTAGE_MS: z.coerce.number().int().nonnegative().default(5000),
		MAX_ATTEMPTS: z.coerce.number().int().positive().default(10)
	})
	.parse(process.env);

const RTT = 50;
const WINDOW_MS = 100;
const CAPACITY_PER_WINDOW = 10;
const JOBS_PER_SECOND = 50;
const DURATION = 20_000;
const BASE = 100;
const CAP = 20_000;

type Policy = { name: string; delay: (attempt: number, random: () => number) => number };

// attempt = the number of the attempt that just failed (1, 2, …)
const policies: Policy[] = [
	{ name: 'retry immediately', delay: () => 0 },
	{ name: 'fixed 1 s later', delay: () => 1000 },
	{ name: 'exponential (no jitter)', delay: (n) => Math.min(CAP, BASE * 2 ** (n - 1)) },
	{
		name: 'exponential + full jitter',
		// "full jitter" from the AWS Architecture Blog (Marc Brooker, 2015): random between 0 and the exponential bound
		delay: (n, random) => random() * Math.min(CAP, BASE * 2 ** (n - 1))
	}
];

type Result = {
	attempts: number;
	succeeded: number;
	exhausted: number;
	peakPerWindow: number;
	lastSuccess: number;
	latencies: number[];
	perSecond: number[];
};

type Scenario = { title: string; arrivals: number[]; outageMs: number };

function run(policy: Policy, scenario: Scenario): Result {
	const sim = new Sim();
	const random = mulberry32(env.SEED);
	const used = new Map<number, number>();
	const perWindow = new Map<number, number>();
	const r: Result = {
		attempts: 0,
		succeeded: 0,
		exhausted: 0,
		peakPerWindow: 0,
		lastSuccess: 0,
		latencies: [],
		perSecond: []
	};

	const attempt = (arrivedAt: number, n: number): void => {
		r.attempts++;
		const w = Math.floor(sim.now / WINDOW_MS);
		const load = (perWindow.get(w) ?? 0) + 1;
		perWindow.set(w, load);
		r.peakPerWindow = Math.max(r.peakPerWindow, load);
		const second = Math.floor(sim.now / 1000);
		r.perSecond[second] = (r.perSecond[second] ?? 0) + 1;

		let ok = false;
		if (sim.now >= scenario.outageMs && (used.get(w) ?? 0) < CAPACITY_PER_WINDOW) {
			used.set(w, (used.get(w) ?? 0) + 1);
			ok = true;
		}
		sim.after(RTT, () => {
			if (ok) {
				r.succeeded++;
				r.lastSuccess = sim.now;
				r.latencies.push(sim.now - arrivedAt);
				return;
			}
			if (n >= env.MAX_ATTEMPTS) {
				r.exhausted++;
				return;
			}
			sim.after(policy.delay(n, random), () => attempt(arrivedAt, n + 1));
		});
	};

	for (const t of scenario.arrivals) sim.at(t, () => attempt(sim.now, 1));
	sim.run(10 * 60_000);
	return r;
}

const fmt = (ms: number): string =>
	ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;

const scenarios: Scenario[] = [
	{
		title: `(a) everyone at once: 1000 jobs at t = 0, provider up`,
		arrivals: Array.from({ length: 1000 }, () => 0),
		outageMs: 0
	},
	{
		title: `(b) outage: ${(DURATION / 1000) * JOBS_PER_SECOND} jobs (${JOBS_PER_SECOND}/s, for ${DURATION / 1000} s), provider down 0–${fmt(env.OUTAGE_MS)}`,
		arrivals: Array.from(
			{ length: (DURATION / 1000) * JOBS_PER_SECOND },
			(_, i) => (i * 1000) / JOBS_PER_SECOND
		),
		outageMs: env.OUTAGE_MS
	}
];

console.log(
	`\n   provider can take ${(CAPACITY_PER_WINDOW * 1000) / WINDOW_MS}/s (${CAPACITY_PER_WINDOW} per ${WINDOW_MS} ms) · at most ${env.MAX_ATTEMPTS} attempts per job · exponential: ${BASE} ms × 2^(n−1), at most ${fmt(CAP)}`
);
for (const scenario of scenarios) {
	console.log(`\n── ${scenario.title}\n`);
	console.log(
		'   policy                        attempts     max per 100ms     ok    gave up   last ok  delay p99'
	);
	const results: [Policy, Result][] = policies.map((p) => [p, run(p, scenario)]);
	for (const [p, r] of results) {
		console.log(
			`   ${p.name.padEnd(28)}${String(r.attempts).padStart(10)}${String(r.peakPerWindow).padStart(18)}${String(r.succeeded).padStart(7)}${String(r.exhausted).padStart(11)}${fmt(r.lastSuccess).padStart(10)}${fmt(percentile(r.latencies, 99)).padStart(11)}`
		);
	}
	const from = Math.floor(scenario.outageMs / 1000);
	console.log(
		`\n   attempts reaching the provider per second (from ${from} s; the provider can take 100/s):`
	);
	console.log(
		`   ${'second'.padEnd(28)}${Array.from({ length: 8 }, (_, i) => String(from + i).padStart(6)).join('')}`
	);
	for (const [p, r] of results) {
		console.log(
			`   ${p.name.padEnd(28)}${Array.from({ length: 8 }, (_, i) => String(r.perSecond[from + i] ?? 0).padStart(6)).join('')}`
		);
	}
}
