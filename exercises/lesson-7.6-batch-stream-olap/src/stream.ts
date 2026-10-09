import { z } from 'zod';
import { mulberry32, percentile, uniform } from './random';

// Lesson 7.6 §1.4–1.5 - "how many tasks were completed each hour" - batch vs stream, and late events.
//
// Every event has two times: event time (when the task was really completed) and arrival time (when the news arrived).
// Most news arrives almost immediately; some from the mobile app a few minutes later (when the network returns); and some
// from an offline laptop a few hours later (when it syncs). During working hours (9–6) there are three times as many events. And at 13:00–14:00
// an event pipeline outage: that hour's news piles up, and all arrives between 14:00–14:10
// (like Module 7's backlog).
//
// Two questions: **when** was each hour's count available, and **how accurate** was it.
// Seeded - exactly the same numbers every time. SEED changes the randomness.

const env = z
	.object({
		SEED: z.coerce.number().int().default(7),
		EVENTS_PER_HOUR: z.coerce.number().int().positive().default(2000),
		LATE_SHARE: z.coerce.number().min(0).max(1).default(0.02),
		// the outage hour (13 means 13:00–14:00); -1 means no outage
		OUTAGE_HOUR: z.coerce.number().int().min(-1).max(23).default(13)
	})
	.parse(process.env);

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY_HOURS = 24;
const BATCH_AT = 26 * HOUR; // at 2 a.m., for the previous day

type Event = { eventTime: number; arrival: number };

const hourOf = (t: number): number => Math.floor(t / HOUR);

function generate(): Event[] {
	const random = mulberry32(env.SEED);
	const events: Event[] = [];
	// 26 hours of events - the last two hours only to push the watermark past the end of the day
	const total = env.EVENTS_PER_HOUR * 26;
	while (events.length < total) {
		const eventTime = random() * 26 * HOUR;
		// three times as many during working hours: keep one in three of the events outside them
		const h = hourOf(eventTime) % 24;
		if ((h < 9 || h >= 18) && random() > 1 / 3) continue;
		const r = random();
		let delay: number;
		if (r < env.LATE_SHARE)
			delay = uniform(random, 1 * HOUR, 6 * HOUR); // offline laptop
		else if (r < env.LATE_SHARE + 0.08)
			delay = uniform(random, 1 * MIN, 10 * MIN); // mobile, when the network returns
		else delay = -Math.log(1 - random()) * SEC; // most: 1 second on average
		let arrival = eventTime + delay;
		// the outage hour's news: together, after the pipeline returns (14:00–14:10)
		if (hourOf(eventTime) === env.OUTAGE_HOUR && arrival < (env.OUTAGE_HOUR + 1) * HOUR)
			arrival = (env.OUTAGE_HOUR + 1) * HOUR + uniform(random, 0, 10 * MIN);
		events.push({ eventTime, arrival });
	}
	return events.sort((a, b) => a.arrival - b.arrival);
}

interface Outcome {
	name: string;
	delays: number[]; // how long until each hour's first result (from the end of the hour)
	firstError: number; // sum of |error| in the first result, as a share of the total events
	worstHour: number; // the worst hour's error in the first result, as a share of that hour's real count
	finalError: number; // after every correction
	dropped: number; // not counted (arrived late and dropped)
	updates: number; // how many corrections were sent after the first result
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

	// 1. Batch: at 2 a.m., every event that has arrived by that moment, by event time
	{
		const counts = new Array<number>(DAY_HOURS).fill(0);
		let dropped = 0;
		for (const e of inDay) {
			if (e.arrival <= BATCH_AT) counts[hourOf(e.eventTime)]! += 1;
			else dropped++;
		}
		outcomes.push({
			name: 'batch (2 a.m., previous day)',
			delays: Array.from({ length: DAY_HOURS }, (_, h) => BATCH_AT - (h + 1) * HOUR),
			firstError: errorOf(counts),
			worstHour: worstOf(counts),
			finalError: errorOf(counts),
			dropped,
			updates: 0
		});
	}

	// 2. Stream, processing time: counted in the hour the news **arrived**; the result as soon as the hour ends
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

	// 3. Stream, event time + watermark: watermark = the largest event time seen − L.
	//    When the watermark passes the end of an hour, that hour's result goes out. If that hour's events arrive after that:
	//    'drop' - dropped; 'update' - a corrected result sent again; 'batch' - dropped, but the nightly batch fixes it
	const watermark = (lateness: number, late: 'drop' | 'update' | 'batch', name: string): void => {
		const counts = new Array<number>(DAY_HOURS).fill(0);
		const first = new Array<number | null>(DAY_HOURS).fill(null);
		const delays: number[] = [];
		let maxEventTime = 0;
		let next = 0; // the next hour whose result will go out
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
	watermark(10 * MIN, 'update', 'stream 10 min + late corrections');
	watermark(10 * MIN, 'batch', 'stream 10 min + nightly batch');

	const fmt = (ms: number): string =>
		ms >= HOUR
			? `${(ms / HOUR).toFixed(1)} h`
			: ms >= MIN
				? `${(ms / MIN).toFixed(1)} min`
				: `${(ms / SEC).toFixed(1)} s`;
	const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

	console.log(
		`\n   ${totalInDay.toLocaleString('en-US')} task.completed in one day · ${(1 - env.LATE_SHARE - 0.08) * 100}% almost immediately, 8% 1–10 minutes late, ${env.LATE_SHARE * 100}% 1–6 hours late${env.OUTAGE_HOUR >= 0 ? ` · ${env.OUTAGE_HOUR}:00–${env.OUTAGE_HOUR + 1}:00 pipeline outage` : ''}\n`
	);
	console.log(
		'   approach                                  first result p50/max      first error     worst hour  end error   dropped  updates'
	);
	for (const o of outcomes) {
		console.log(
			`   ${o.name.padEnd(40)}${`${fmt(percentile(o.delays, 50))} / ${fmt(Math.max(...o.delays))}`.padStart(22)}${pct(o.firstError).padStart(17)}${pct(o.worstHour).padStart(15)}${pct(o.finalError).padStart(11)}${String(o.dropped).padStart(10)}${String(o.updates).padStart(9)}`
		);
	}
	console.log(
		'\n   ("error" = the sum of the differences between each hour\'s count and the real count, as a share of the day\'s total events)'
	);
}

main();
