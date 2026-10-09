import { z } from 'zod';
import { runLog, runPubSub, runQueue, type LogOptions } from './brokers';
import { Recorder, type Outage, type ServiceReport, type ServiceSpec } from './model';
import { mulberry32, uniform } from './random';
import { Sim } from './sim';
import { generateEvents, type TaskEvent } from './workload';

// Lesson 7.2 - the same stream of TaskFlow events, three kinds of broker, five situations:
//
//   npm run fanout    - three services want the same events (§1.2)
//   npm run crash     - the search service is down for 10 seconds (deploy) (§1.3)
//   npm run slow      - the analytics service is slower than the arrival rate (§1.3)
//   npm run replay    - a new service arrives and wants every old event (§1.4)
//   npm run ordering  - events of the same task must be processed in order (§1.5)
//   npm run all       - all of them
//
// Seeded - exactly the same numbers every time. Can be changed with the SEED env.

const scenario = z
	.enum(['fanout', 'crash', 'slow', 'replay', 'ordering', 'all'])
	.parse(process.argv[2] ?? 'all');
const env = z
	.object({
		SEED: z.coerce.number().int().default(7),
		// For experiments: the log's partition count, the offset commit interval, the pub/sub buffer limit
		PARTITIONS: z.coerce.number().int().positive().default(4),
		COMMIT_MS: z.coerce.number().int().positive().default(5000),
		BUFFER_LIMIT: z.coerce.number().int().positive().default(100)
	})
	.parse(process.env);
const seed = env.SEED;

// The processing time of every (service, event) pair is the same on every broker - so the comparison stays honest
function perEvent(
	salt: number,
	pick: (random: () => number) => number
): (event: TaskEvent) => number {
	return (event) => Math.round(pick(mulberry32(seed * 1_000_003 + salt * 7919 + event.id)));
}

const email: ServiceSpec = {
	name: 'email',
	workers: 2,
	processMs: perEvent(1, (r) => uniform(r, 40, 80))
};
const search: ServiceSpec = {
	name: 'search',
	workers: 2,
	processMs: perEvent(2, (r) => uniform(r, 10, 30))
};
const analytics: ServiceSpec = {
	name: 'analytics',
	workers: 1,
	processMs: perEvent(3, (r) => uniform(r, 2, 8))
};

const DURATION = 60_000;
const DRAIN = 120_000; // time for everyone to finish after publishing stops

type Broker = 'pubsub' | 'queue' | 'log';

function simulate(run: (sim: Sim, rec: Recorder) => void, until = DURATION + DRAIN): Recorder {
	const sim = new Sim();
	const rec = new Recorder();
	run(sim, rec);
	sim.run(until);
	return rec;
}

function logDefaults(overrides: Partial<LogOptions> = {}): LogOptions {
	return {
		partitions: env.PARTITIONS,
		key: 'task',
		commitIntervalMs: env.COMMIT_MS,
		retentionMs: 7 * 24 * 3600 * 1000,
		outages: [],
		random: mulberry32(seed + 99),
		...overrides
	};
}

function runBroker(
	broker: Broker,
	events: TaskEvent[],
	services: ServiceSpec[],
	outages: Outage[] = [],
	log: Partial<LogOptions> = {}
): Recorder {
	return simulate((sim, rec) => {
		if (broker === 'pubsub')
			runPubSub(sim, events, services, rec, {
				bufferLimit: env.BUFFER_LIMIT,
				reconnectMs: 1000,
				outages
			});
		else if (broker === 'queue')
			runQueue(sim, events, services, rec, { layout: 'per-service', ackDelayMs: 5, outages });
		else
			runLog(
				sim,
				events,
				services.map((s) => ({ service: s, consumers: s.workers })),
				rec,
				logDefaults({ outages, ...log })
			);
	});
}

const fmt = (ms: number): string =>
	ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const pct = (r: ServiceReport): string =>
	`${Math.round((r.received / Math.max(1, r.expected)) * 100)}%`;
const row = (cells: [string, number][]): string =>
	cells.map(([text, width]) => text.padStart(width)).join('');

function header(title: string, note: string): void {
	console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 70 - title.length))}`);
	console.log(`   ${note}\n`);
}

// ── 1. Fanout ─────────────────────────────────────────────────────────────────────────

function fanout(events: TaskEvent[]): void {
	header(
		'fanout',
		`${events.length} events; email, search and analytics - all three need every one of them`
	);
	const services = [email, search, analytics];
	const variants: [string, Recorder][] = [
		[
			'queue - one shared queue',
			simulate((sim, rec) =>
				runQueue(sim, events, services, rec, { layout: 'shared', ackDelayMs: 5, outages: [] })
			)
		],
		['queue - one queue per service', runBroker('queue', events, services)],
		['pub/sub', runBroker('pubsub', events, services)],
		['log - one group per service', runBroker('log', events, services)]
	];
	console.log('   broker                           email got   search got   analytics got');
	for (const [name, rec] of variants) {
		const [e, s, a] = services.map((svc) => rec.report(svc.name, events));
		if (!e || !s || !a) continue;
		console.log(
			`   ${name.padEnd(32)}${row([
				[pct(e), 10],
				[pct(s), 13],
				[pct(a), 16]
			])}`
		);
	}
}

// ── 2. Crash ──────────────────────────────────────────────────────────────────────────

function crash(events: TaskEvent[]): void {
	const outage: Outage = { service: 'search', from: 20_000, to: 30_000 };
	header('crash', 'search service down from 20 s to 30 s (deploy); the others keep running');
	const services = [email, search, analytics];
	const variants: [string, Recorder][] = [
		['pub/sub', runBroker('pubsub', events, services, [outage])],
		['queue (ack per message)', runBroker('queue', events, services, [outage])],
		[`log (commit every ${fmt(env.COMMIT_MS)})`, runBroker('log', events, services, [outage])],
		[
			'log (commit every 100 ms)',
			runBroker('log', events, services, [outage], { commitIntervalMs: 100 })
		]
	];
	console.log('   broker                           lost  processed twice  delay p99  delay max');
	for (const [name, rec] of variants) {
		const r = rec.report('search', events);
		console.log(
			`   ${name.padEnd(30)}${row([
				[String(r.lost), 7],
				[String(r.duplicates), 17],
				[fmt(r.p99), 11],
				[fmt(r.max), 11]
			])}`
		);
	}
}

// ── 3. Slow consumer ──────────────────────────────────────────────────────────────────

function slow(events: TaskEvent[]): void {
	const slowAnalytics: ServiceSpec = {
		...analytics,
		processMs: perEvent(4, (r) => uniform(r, 60, 100))
	};
	const perSecond = (events.length / (DURATION / 1000)).toFixed(1);
	header(
		'slow',
		`analytics has 1 worker, 60–100 ms per event (≈12.5/s); events arrive at ≈${perSecond}/s`
	);
	const services = [email, search, slowAnalytics];
	console.log(
		'   broker      analytics lost    backlog (max)  analytics delay max  email delay p99'
	);
	for (const broker of ['pubsub', 'queue', 'log'] as const) {
		const rec = runBroker(broker, events, services);
		const a = rec.report('analytics', events);
		const e = rec.report('email', events);
		console.log(
			`   ${broker.padEnd(9)}${row([
				[String(a.lost), 17],
				[String(a.backlogPeak), 17],
				[fmt(a.max), 21],
				[fmt(e.p99), 17]
			])}`
		);
	}
	console.log(
		'\n   (the log\'s "backlog" = consumer lag - in the log but not yet read by analytics; nothing extra for the broker)'
	);
}

// ── 4. Replay ─────────────────────────────────────────────────────────────────────────

function replay(): void {
	const JOIN = 60_000;
	const events = generateEvents(mulberry32(seed), 90_000, 4);
	const before = events.filter((e) => e.publishedAt < JOIN);
	const after = events.filter((e) => e.publishedAt >= JOIN);
	const searchV2: ServiceSpec = { ...search, name: 'search-v2' };
	header(
		'replay',
		`the new search-v2 joined at 60 s; it needs every event to build the full index (${before.length} earlier, ${after.length} later)`
	);
	const variants: [string, Recorder][] = [
		[
			'pub/sub',
			simulate((sim, rec) =>
				runPubSub(sim, events, [searchV2], rec, {
					bufferLimit: env.BUFFER_LIMIT,
					reconnectMs: 1000,
					outages: [],
					joinAt: { 'search-v2': JOIN }
				})
			)
		],
		[
			'queue',
			simulate((sim, rec) =>
				runQueue(sim, events, [searchV2], rec, {
					layout: 'per-service',
					ackDelayMs: 5,
					outages: [],
					joinAt: { 'search-v2': JOIN }
				})
			)
		],
		...(
			[
				['log (retention 7 days)', 7 * 24 * 3600 * 1000],
				['log (retention 30 s)', 30_000]
			] as const
		).map(([name, retentionMs]): [string, Recorder] => [
			name,
			simulate((sim, rec) =>
				runLog(
					sim,
					events,
					[{ service: searchV2, consumers: 2, joinAt: JOIN }],
					rec,
					logDefaults({ retentionMs })
				)
			)
		])
	];
	console.log('   broker                  earlier events     later events');
	for (const [name, rec] of variants) {
		const b = rec.report('search-v2', before);
		const a = rec.report('search-v2', after);
		console.log(
			`   ${name.padEnd(23)}${row([
				[`${b.received} / ${b.expected}`, 15],
				[`${a.received} / ${a.expected}`, 17]
			])}`
		);
	}
}

// ── 5. Ordering ───────────────────────────────────────────────────────────────────────

function ordering(events: TaskEvent[]): void {
	// 20–120 ms per event, but 3 s on 1% (a slow moment at the provider)
	const notifier = (workers: number): ServiceSpec => ({
		name: 'notifier',
		workers,
		processMs: perEvent(5, (r) => (r() < 0.01 ? 3000 : uniform(r, 20, 120)))
	});
	const tasks = new Set(events.map((e) => e.taskId)).size;
	header(
		'ordering',
		`notifier service, ${tasks} tasks - events of the same task should be processed in order`
	);
	const variants: [string, Recorder, string][] = [
		[
			'queue, 4 worker',
			simulate((sim, rec) =>
				runQueue(sim, events, [notifier(4)], rec, {
					layout: 'per-service',
					ackDelayMs: 5,
					outages: []
				})
			),
			'4'
		],
		[
			`log, key = task, ${env.PARTITIONS} partition`,
			simulate((sim, rec) =>
				runLog(sim, events, [{ service: notifier(4), consumers: 4 }], rec, logDefaults())
			),
			String(Math.min(4, env.PARTITIONS))
		],
		[
			`log, key = random, ${env.PARTITIONS} partition`,
			simulate((sim, rec) =>
				runLog(
					sim,
					events,
					[{ service: notifier(4), consumers: 4 }],
					rec,
					logDefaults({ key: 'random' })
				)
			),
			String(Math.min(4, env.PARTITIONS))
		],
		[
			'log, key = task, 8 consumer',
			simulate((sim, rec) =>
				runLog(sim, events, [{ service: notifier(8), consumers: 8 }], rec, logDefaults())
			),
			env.PARTITIONS >= 8 ? '8' : `${env.PARTITIONS} (${8 - env.PARTITIONS} idle)`
		]
	];
	console.log(
		'   broker                      tasks out of order  delay p50  delay p99  delay max   consumers with work'
	);
	for (const [name, rec, busy] of variants) {
		const r = rec.report('notifier', events);
		console.log(
			`   ${name.padEnd(31)}${row([
				[String(r.disorderedTasks), 15],
				[fmt(r.p50), 11],
				[fmt(r.p99), 11],
				[fmt(r.max), 11]
			])}   ${busy}`
		);
	}
}

function main(): void {
	const events = generateEvents(mulberry32(seed), DURATION, 4);
	if (scenario === 'fanout' || scenario === 'all') fanout(events);
	if (scenario === 'crash' || scenario === 'all') crash(events);
	if (scenario === 'slow' || scenario === 'all') slow(events);
	if (scenario === 'replay' || scenario === 'all') replay();
	if (scenario === 'ordering' || scenario === 'all') ordering(events);
}

main();
