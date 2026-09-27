import { z } from 'zod';
import { mulberry32, percentile, uniform } from './random';

// Lesson 7.6 §১.৪–১.৫ — "প্রতি ঘণ্টায় কয়টা task complete হলো" — batch বনাম stream, আর দেরিতে আসা ঘটনা।
//
// প্রতিটা ঘটনার দুটো সময়: event time (task আসলে কখন complete হলো) আর arrival time (খবর কখন পৌঁছাল)।
// বেশিরভাগ খবর প্রায় সাথে সাথে আসে; কিছু mobile app থেকে কয়েক মিনিট পরে (network ফিরলে); আর কিছু
// offline laptop থেকে কয়েক ঘণ্টা পরে (sync হলে)। কাজের সময়ে (৯টা–৬টা) ঘটনা তিন গুণ। আর 13:00–14:00
// এ event pipeline এর একটা outage: সেই ঘণ্টার খবর জমে থাকে, 14:00–14:10 এর মধ্যে একসাথে পৌঁছায়
// (Module 7 এর backlog এর মতো)।
//
// প্রশ্ন দুটো: প্রতিটা ঘণ্টার সংখ্যা **কখন** পাওয়া গেল, আর **কতটা ঠিক** ছিল।
// Seed দেওয়া — প্রতিবার হুবহু একই সংখ্যা। Random কিছু বদলাতে SEED।

const env = z
	.object({
		SEED: z.coerce.number().int().default(7),
		EVENTS_PER_HOUR: z.coerce.number().int().positive().default(2000),
		LATE_SHARE: z.coerce.number().min(0).max(1).default(0.02),
		// outage এর ঘণ্টা (13 মানে 13:00–14:00); -1 দিলে outage নেই
		OUTAGE_HOUR: z.coerce.number().int().min(-1).max(23).default(13)
	})
	.parse(process.env);

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY_HOURS = 24;
const BATCH_AT = 26 * HOUR; // রাত ২টায়, আগের দিনের জন্য

type Event = { eventTime: number; arrival: number };

const hourOf = (t: number): number => Math.floor(t / HOUR);

function generate(): Event[] {
	const random = mulberry32(env.SEED);
	const events: Event[] = [];
	// ২৬ ঘণ্টার ঘটনা — শেষ দুই ঘণ্টা শুধু watermark কে দিনের শেষ পার করানোর জন্য
	const total = env.EVENTS_PER_HOUR * 26;
	while (events.length < total) {
		const eventTime = random() * 26 * HOUR;
		// কাজের সময়ে তিন গুণ: বাকি সময়ের ঘটনা তিনটার একটা রাখা
		const h = hourOf(eventTime) % 24;
		if ((h < 9 || h >= 18) && random() > 1 / 3) continue;
		const r = random();
		let delay: number;
		if (r < env.LATE_SHARE)
			delay = uniform(random, 1 * HOUR, 6 * HOUR); // offline laptop
		else if (r < env.LATE_SHARE + 0.08)
			delay = uniform(random, 1 * MIN, 10 * MIN); // mobile, network ফিরলে
		else delay = -Math.log(1 - random()) * SEC; // বেশিরভাগ: গড়ে ১ সেকেন্ড
		let arrival = eventTime + delay;
		// outage এর ঘণ্টার খবর: pipeline ফেরার পরে (14:00–14:10) একসাথে
		if (hourOf(eventTime) === env.OUTAGE_HOUR && arrival < (env.OUTAGE_HOUR + 1) * HOUR)
			arrival = (env.OUTAGE_HOUR + 1) * HOUR + uniform(random, 0, 10 * MIN);
		events.push({ eventTime, arrival });
	}
	return events.sort((a, b) => a.arrival - b.arrival);
}

interface Outcome {
	name: string;
	delays: number[]; // প্রতিটা ঘণ্টার প্রথম ফল পেতে (ঘণ্টা শেষ হওয়ার পর থেকে) কত দেরি
	firstError: number; // প্রথম ফলে |ভুল| এর যোগফল, মোট ঘটনার অনুপাতে
	worstHour: number; // প্রথম ফলে সবচেয়ে খারাপ ঘণ্টার ভুল, সেই ঘণ্টার আসল সংখ্যার অনুপাতে
	finalError: number; // সব সংশোধনের পরে
	dropped: number; // গোনা হলো না (দেরিতে এসে বাদ)
	updates: number; // প্রথম ফলের পরে কতবার সংশোধন পাঠানো হলো
}

function main(): void {
	const events = generate();
	const inDay = events.filter((e) => e.eventTime < DAY_HOURS * HOUR);
	const truth = new Array<number>(DAY_HOURS).fill(0);
	for (const e of inDay) truth[hourOf(e.eventTime)]! += 1;
	const totalInDay = inDay.length;
	const errorOf = (counts: number[]): number =>
		counts.reduce((sum, c, h) => sum + Math.abs(c - (truth[h] ?? 0)), 0) / totalInDay;
	const worstOf = (counts: number[]): number =>
		counts.reduce(
			(worst, c, h) => Math.max(worst, Math.abs(c - (truth[h] ?? 0)) / Math.max(1, truth[h] ?? 0)),
			0
		);

	const outcomes: Outcome[] = [];

	// ১. Batch: রাত ২টায় সেই মুহূর্ত পর্যন্ত পৌঁছানো সব ঘটনা, event time ধরে
	{
		const counts = new Array<number>(DAY_HOURS).fill(0);
		let dropped = 0;
		for (const e of inDay) {
			if (e.arrival <= BATCH_AT) counts[hourOf(e.eventTime)]! += 1;
			else dropped++;
		}
		outcomes.push({
			name: 'batch (রাত ২টায়, আগের দিন)',
			delays: Array.from({ length: DAY_HOURS }, (_, h) => BATCH_AT - (h + 1) * HOUR),
			firstError: errorOf(counts),
			worstHour: worstOf(counts),
			finalError: errorOf(counts),
			dropped,
			updates: 0
		});
	}

	// ২. Stream, processing time: যে ঘণ্টায় খবর **পৌঁছাল**, সেই ঘণ্টায় গোনা; ঘণ্টা শেষ হলেই ফল
	{
		const counts = new Array<number>(DAY_HOURS).fill(0);
		for (const e of events) {
			const h = hourOf(e.arrival);
			if (h < DAY_HOURS) counts[h]! += 1;
		}
		outcomes.push({
			name: 'stream, processing time',
			delays: new Array<number>(DAY_HOURS).fill(0),
			firstError: errorOf(counts),
			worstHour: worstOf(counts),
			finalError: errorOf(counts),
			dropped: 0,
			updates: 0
		});
	}

	// ৩. Stream, event time + watermark: watermark = দেখা সবচেয়ে বড় event time − L।
	//    Watermark একটা ঘণ্টার শেষ পার হলে সেই ঘণ্টার ফল বের হয়। তার পরে সেই ঘণ্টার ঘটনা এলে:
	//    'drop' — বাদ; 'update' — সংশোধিত ফল আবার পাঠানো; 'batch' — বাদ, কিন্তু রাতের batch ঠিক করে দেয়
	const watermark = (lateness: number, late: 'drop' | 'update' | 'batch', name: string): void => {
		const counts = new Array<number>(DAY_HOURS).fill(0);
		const first = new Array<number | null>(DAY_HOURS).fill(null);
		const delays: number[] = [];
		let maxEventTime = 0;
		let next = 0; // পরের যে ঘণ্টার ফল বের হবে
		let dropped = 0;
		let updates = 0;
		for (const e of events) {
			const h = hourOf(e.eventTime);
			if (h < DAY_HOURS) {
				if (h < next) {
					if (late === 'update') {
						counts[h]! += 1;
						updates++;
					} else dropped++;
				} else counts[h]! += 1;
			}
			maxEventTime = Math.max(maxEventTime, e.eventTime);
			while (next < DAY_HOURS && maxEventTime - lateness >= (next + 1) * HOUR) {
				first[next] = counts[next] ?? 0;
				delays.push(e.arrival - (next + 1) * HOUR);
				next++;
			}
		}
		const firstCounts = first.map((c) => c ?? 0);
		let final = counts;
		if (late === 'batch') {
			final = new Array<number>(DAY_HOURS).fill(0);
			for (const e of inDay) if (e.arrival <= BATCH_AT) final[hourOf(e.eventTime)]! += 1;
			dropped = inDay.filter((e) => e.arrival > BATCH_AT).length;
		}
		outcomes.push({
			name,
			delays,
			firstError: errorOf(firstCounts),
			worstHour: worstOf(firstCounts),
			finalError: errorOf(final),
			dropped,
			updates
		});
	};
	watermark(0, 'drop', 'stream, event time, lateness 0');
	watermark(1 * MIN, 'drop', 'stream, event time, lateness 1 min');
	watermark(10 * MIN, 'drop', 'stream, event time, lateness 10 min');
	watermark(1 * HOUR, 'drop', 'stream, event time, lateness 1 h');
	watermark(10 * MIN, 'update', 'stream 10 min + দেরির সংশোধন');
	watermark(10 * MIN, 'batch', 'stream 10 min + রাতের batch');

	const fmt = (ms: number): string =>
		ms >= HOUR
			? `${(ms / HOUR).toFixed(1)} h`
			: ms >= MIN
				? `${(ms / MIN).toFixed(1)} min`
				: `${(ms / SEC).toFixed(1)} s`;
	const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

	console.log(
		`\n   এক দিনের ${totalInDay.toLocaleString('en-US')} টা task.completed · ${(1 - env.LATE_SHARE - 0.08) * 100}% প্রায় সাথে সাথে, 8% ১–১০ মিনিট দেরিতে, ${env.LATE_SHARE * 100}% ১–৬ ঘণ্টা দেরিতে${env.OUTAGE_HOUR >= 0 ? ` · ${env.OUTAGE_HOUR}:00–${env.OUTAGE_HOUR + 1}:00 pipeline outage` : ''}\n`
	);
	console.log(
		'   পদ্ধতি                                   প্রথম ফল পেতে (p50 / সর্বোচ্চ)   প্রথম ফলে ভুল   খারাপতম ঘণ্টা   শেষে ভুল   বাদ পড়ল   সংশোধন'
	);
	for (const o of outcomes) {
		console.log(
			`   ${o.name.padEnd(40)}${`${fmt(percentile(o.delays, 50))} / ${fmt(Math.max(...o.delays))}`.padStart(22)}${pct(o.firstError).padStart(17)}${pct(o.worstHour).padStart(15)}${pct(o.finalError).padStart(11)}${String(o.dropped).padStart(10)}${String(o.updates).padStart(9)}`
		);
	}
	console.log(
		'\n   ("ভুল" = প্রতিটা ঘণ্টার সংখ্যা আর আসল সংখ্যার পার্থক্যের যোগফল, দিনের মোট ঘটনার অনুপাতে)'
	);
}

main();
