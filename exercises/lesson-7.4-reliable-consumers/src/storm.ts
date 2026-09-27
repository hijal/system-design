import { z } from 'zod';
import { mulberry32, percentile } from './random';
import { Sim } from './sim';

// Lesson 7.4 §১.৩ — Retry storm: চারটা retry নীতি, দুটো পরিস্থিতি।
//
//   (ক) সবাই একসাথে — ১০০০টা job ঠিক একই মুহূর্তে (সকাল ৯টার digest cron, বা outage এর পরে একসাথে
//       ছাড়া পাওয়া backlog)। এখানে প্রশ্ন: ব্যর্থরা কি আবারও একসাথে ফেরে?
//   (খ) outage — job আসে ছড়িয়ে (50/s, 20 s), provider প্রথম OUTAGE_MS বন্ধ।
//
// Provider এর model: প্রতি 100 ms এ সর্বোচ্চ 10টা request সফলভাবে নিতে পারে (100/s); বাড়তি গুলো সাথে
// সাথে 503 পায় — overload এ সে নিজেকে বাঁচায় (load shedding)। প্রতিটা চেষ্টার উত্তর আসতে 50 ms।
// প্রতিটা job সর্বোচ্চ MAX_ATTEMPTS বার চেষ্টা।
//
// Seed দেওয়া — jitter এর random ও প্রতিবার একই। SEED দিয়ে বদলানো যায়।

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

// attempt = এইমাত্র ব্যর্থ হওয়া চেষ্টার নম্বর (1, 2, …)
const policies: Policy[] = [
	{ name: 'সাথে সাথে আবার', delay: () => 0 },
	{ name: 'স্থির 1 s পরে', delay: () => 1000 },
	{ name: 'exponential (jitter ছাড়া)', delay: (n) => Math.min(CAP, BASE * 2 ** (n - 1)) },
	{
		name: 'exponential + full jitter',
		// AWS Architecture Blog (Marc Brooker, 2015) এর "full jitter": 0 থেকে exponential সীমার মধ্যে এলোমেলো
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
		title: `(ক) সবাই একসাথে: 1000 টা job t = 0 তে, provider চালু`,
		arrivals: Array.from({ length: 1000 }, () => 0),
		outageMs: 0
	},
	{
		title: `(খ) outage: ${(DURATION / 1000) * JOBS_PER_SECOND} টা job (${JOBS_PER_SECOND}/s, ${DURATION / 1000} s ধরে), provider 0–${fmt(env.OUTAGE_MS)} বন্ধ`,
		arrivals: Array.from(
			{ length: (DURATION / 1000) * JOBS_PER_SECOND },
			(_, i) => (i * 1000) / JOBS_PER_SECOND
		),
		outageMs: env.OUTAGE_MS
	}
];

console.log(
	`\n   provider নিতে পারে ${(CAPACITY_PER_WINDOW * 1000) / WINDOW_MS}/s (প্রতি ${WINDOW_MS} ms এ ${CAPACITY_PER_WINDOW}টা) · প্রতি job সর্বোচ্চ ${env.MAX_ATTEMPTS} চেষ্টা · exponential: ${BASE} ms × 2^(n−1), সর্বোচ্চ ${fmt(CAP)}`
);
for (const scenario of scenarios) {
	console.log(`\n── ${scenario.title}\n`);
	console.log(
		'   নীতি                          মোট চেষ্টা   100ms এ সর্বোচ্চ   সফল   হাল ছাড়ল   শেষ সফল   দেরি p99'
	);
	const results: [Policy, Result][] = policies.map((p) => [p, run(p, scenario)]);
	for (const [p, r] of results) {
		console.log(
			`   ${p.name.padEnd(28)}${String(r.attempts).padStart(10)}${String(r.peakPerWindow).padStart(18)}${String(r.succeeded).padStart(7)}${String(r.exhausted).padStart(11)}${fmt(r.lastSuccess).padStart(10)}${fmt(percentile(r.latencies, 99)).padStart(11)}`
		);
	}
	const from = Math.floor(scenario.outageMs / 1000);
	console.log(
		`\n   প্রতি সেকেন্ডে provider এ আসা চেষ্টা (${from} s থেকে; provider নিতে পারে 100/s):`
	);
	console.log(
		`   ${'সেকেন্ড'.padEnd(28)}${Array.from({ length: 8 }, (_, i) => String(from + i).padStart(6)).join('')}`
	);
	for (const [p, r] of results) {
		console.log(
			`   ${p.name.padEnd(28)}${Array.from({ length: 8 }, (_, i) => String(r.perSecond[from + i] ?? 0).padStart(6)).join('')}`
		);
	}
}
