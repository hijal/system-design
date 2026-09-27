import { z } from 'zod';
import { percentile } from './random';

// Lesson 7.4 §১.৫ — Backpressure: consumer প্রতি সেকেন্ডে 100টা পারে। দুই ধরনের load, চারটা নীতি।
//
//   burst     — 5 s ধরে 300/s, তারপর 50/s (মোট গড়ে consumer এর নিচে — শুধু একটা ঢেউ)
//   sustained — পুরো 60 s ধরে 130/s (সবসময় consumer এর উপরে)
//
// অর্ধেক job "জরুরি" (password reset, mention), অর্ধেক "কম জরুরি" (weekly digest, analytics)।
// সময় 10 ms এর ধাপে চলে; প্রতি ধাপে consumer একটা job নেয় (100/s)। Random কিছু নেই।

const env = z.object({ LIMIT: z.coerce.number().int().positive().default(500) }).parse(process.env);

const TICK = 10;
const DURATION = 60_000;
const DRAIN_UNTIL = 300_000;
const SHED_AT = 300; // এর বেশি লাইন হলে কম জরুরি job আর নেওয়া হয় না

type Priority = 'high' | 'low';
type Job = { createdAt: number; priority: Priority };
type Pattern = { name: string; rate: (t: number) => number };
type Strategy = 'unbounded' | 'reject' | 'block' | 'shed';

const patterns: Pattern[] = [
	{ name: 'burst (5 s এ 300/s, তারপর 50/s)', rate: (t) => (t < 5000 ? 300 : 50) },
	{ name: 'sustained (সবসময় 130/s)', rate: () => 130 }
];

const strategies: { key: Strategy; name: string }[] = [
	{ key: 'unbounded', name: 'সীমাহীন queue' },
	{ key: 'reject', name: `সীমা ${env.LIMIT}, বেশি হলে 503` },
	{ key: 'block', name: `সীমা ${env.LIMIT}, producer অপেক্ষা করে` },
	{ key: 'shed', name: `অগ্রাধিকার: ${SHED_AT} এর পরে কম জরুরি বাদ` }
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
	// block নীতিতে: queue ভরা থাকায় producer এর কাছে আটকে থাকা request (user এর HTTP request ঝুলে আছে)
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
		// আগে আটকে থাকা producer রা, আসার ক্রমে
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

		// consumer: প্রতি ধাপে একটা; shed নীতিতে জরুরিটা আগে (priority queue)
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

console.log(`\n   consumer 100/s · 60 s ধরে load · অর্ধেক জরুরি, অর্ধেক কম জরুরি`);
for (const pattern of patterns) {
	console.log(`\n── ${pattern.name}\n`);
	console.log(
		'   নীতি                                   queue সর্বোচ্চ   producer এ আটকে   ফেরানো (জরুরি / কম)   অপেক্ষা p99 (সব / জরুরি)   শেষ কাজ'
	);
	for (const s of strategies) {
		const r = run(pattern, s.key);
		console.log(
			`   ${s.name.padEnd(38)}${String(r.maxQueue).padStart(14)}${String(r.maxProducerWaiting).padStart(17)}${`${r.rejectedHigh} / ${r.rejectedLow}`.padStart(22)}${`${fmt(percentile(r.waitAll, 99))} / ${fmt(percentile(r.waitHigh, 99))}`.padStart(26)}${fmt(r.lastDone).padStart(10)}`
		);
	}
}
console.log(
	'\n   ("অপেক্ষা" = job তৈরি থেকে consumer এর হাতে পৌঁছানো; block নীতিতে এর মধ্যে producer এ আটকে থাকার সময়ও আছে)'
);
