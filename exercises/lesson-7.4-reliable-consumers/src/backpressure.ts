import { z } from 'zod';
import { percentile } from './random';

// Lesson 7.4 §1.5 — Backpressure: the consumer can do 100 per second. Two kinds of load, four policies.
//
//   burst     — 300/s for 5 s, then 50/s (on average below the consumer — just one wave)
//   sustained — 130/s for the full 60 s (always above the consumer)
//
// Half the jobs are "urgent" (password reset, mention), half "less urgent" (weekly digest, analytics).
// Time moves in 10 ms steps; on each step the consumer takes one job (100/s). Nothing is random.

const env = z.object({ LIMIT: z.coerce.number().int().positive().default(500) }).parse(process.env);

const TICK = 10;
const DURATION = 60_000;
const DRAIN_UNTIL = 300_000;
const SHED_AT = 300; // above this queue length, less urgent jobs are no longer accepted

type Priority = 'high' | 'low';
type Job = { createdAt: number; priority: Priority };
type Pattern = { name: string; rate: (t: number) => number };
type Strategy = 'unbounded' | 'reject' | 'block' | 'shed';

const patterns: Pattern[] = [
	{ name: 'burst (300/s for 5 s, then 50/s)', rate: (t) => (t < 5000 ? 300 : 50) },
	{ name: 'sustained (always 130/s)', rate: () => 130 }
];

const strategies: { key: Strategy; name: string }[] = [
	{ key: 'unbounded', name: 'unbounded queue' },
	{ key: 'reject', name: `limit ${env.LIMIT}, 503 when full` },
	{ key: 'block', name: `limit ${env.LIMIT}, producer waits` },
	{ key: 'shed', name: `priority: drop less urgent above ${SHED_AT}` }
];

interface Result {
	created: number;
	rejectedHigh: number;
	rejectedLow: number;
	maxQueue: number;
	maxProducerWaiting: number;
	waitHigh: number[];
	waitAll: number[];
	lastDone: number;
}

function run(pattern: Pattern, strategy: Strategy): Result {
	const queue: Job[] = [];
	// with the block policy: requests held at the producer because the queue is full (the user's HTTP request hangs)
	const producerWaiting: Job[] = [];
	const r: Result = {
		created: 0,
		rejectedHigh: 0,
		rejectedLow: 0,
		maxQueue: 0,
		maxProducerWaiting: 0,
		waitHigh: [],
		waitAll: [],
		lastDone: 0
	};
	let carry = 0;
	let n = 0;

	const offer = (job: Job): boolean => {
		if (strategy === 'unbounded') return queue.push(job) > 0;
		if (strategy === 'shed' && job.priority === 'low' && queue.length >= SHED_AT) return false;
		if (queue.length >= env.LIMIT) return false;
		queue.push(job);
		return true;
	};

	for (let t = 0; t < DRAIN_UNTIL; t += TICK) {
		// producers held earlier go first, in order of arrival
		while (producerWaiting.length > 0 && queue.length < env.LIMIT) {
			const job = producerWaiting.shift();
			if (job) queue.push(job);
		}
		if (t < DURATION) {
			carry += (pattern.rate(t) * TICK) / 1000;
			while (carry >= 1) {
				carry -= 1;
				const job: Job = { createdAt: t, priority: n++ % 2 === 0 ? 'high' : 'low' };
				r.created++;
				if (offer(job)) continue;
				if (strategy === 'block') producerWaiting.push(job);
				else if (job.priority === 'high') r.rejectedHigh++;
				else r.rejectedLow++;
			}
		}
		r.maxQueue = Math.max(r.maxQueue, queue.length);
		r.maxProducerWaiting = Math.max(r.maxProducerWaiting, producerWaiting.length);

		// consumer: one per step; with the shed policy the urgent one goes first (priority queue)
		let index = 0;
		if (strategy === 'shed') {
			const high = queue.findIndex((j) => j.priority === 'high');
			if (high !== -1) index = high;
		}
		const [job] = queue.splice(index, 1);
		if (job) {
			const wait = t - job.createdAt;
			r.waitAll.push(wait);
			if (job.priority === 'high') r.waitHigh.push(wait);
			r.lastDone = t;
		}
		if (t >= DURATION && queue.length === 0 && producerWaiting.length === 0) break;
	}
	return r;
}

const fmt = (ms: number): string =>
	ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;

console.log(`\n   consumer 100/s · load for 60 s · half urgent, half less urgent`);
for (const pattern of patterns) {
	console.log(`\n── ${pattern.name}\n`);
	console.log(
		'   policy                                     queue max    producer held   rejected (urgent / low)   wait p99 (all / urgent)  finished'
	);
	for (const s of strategies) {
		const r = run(pattern, s.key);
		console.log(
			`   ${s.name.padEnd(38)}${String(r.maxQueue).padStart(14)}${String(r.maxProducerWaiting).padStart(17)}${`${r.rejectedHigh} / ${r.rejectedLow}`.padStart(26)}${`${fmt(percentile(r.waitAll, 99))} / ${fmt(percentile(r.waitHigh, 99))}`.padStart(26)}${fmt(r.lastDone).padStart(10)}`
		);
	}
}
console.log(
	'\n   ("wait" = from job creation until it reaches the consumer; with the block policy it includes the time held at the producer)'
);
