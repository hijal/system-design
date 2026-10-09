import { type Outage, type Recorder, type ServiceSpec } from './model';
import type { Sim } from './sim';
import type { TaskEvent } from './workload';

// Lesson 7.2 - three kinds of broker, each with the core behaviour of its real counterpart:
//
//   runPubSub  - like Redis Pub/Sub: whoever is connected right now gets it; nothing is stored
//   runQueue   - like a RabbitMQ queue: messages are stored, one consumer gets each, deleted on ack
//   runLog     - like Kafka / Redis Streams: append-only log, partitions, consumer groups and offsets
//
// Every service's workers process events; "processing done" means the side effect has happened.
// Work that was half done at the moment of an outage is discarded (no side effect).

interface Workers {
	busy: number;
	down: boolean;
	// Goes up on an outage - in-flight work of an old generation is not counted even if it finishes
	generation: number;
}

function scheduleOutages(
	sim: Sim,
	outages: Outage[],
	service: string,
	onDown: () => void,
	onUp: () => void
): void {
	for (const outage of outages.filter((o) => o.service === service)) {
		sim.at(outage.from, onDown);
		sim.at(outage.to, onUp);
	}
}

// ── Pub/Sub ─────────────────────────────────────────────────────────────────────────────

export interface PubSubOptions {
	// Limit on messages piled up in the broker for a subscriber (like Redis's client-output-buffer-limit)
	bufferLimit: number;
	reconnectMs: number;
	outages: Outage[];
	// A service that subscribes late: it was not connected before this moment
	joinAt?: Record<string, number>;
}

export function runPubSub(
	sim: Sim,
	events: TaskEvent[],
	services: ServiceSpec[],
	rec: Recorder,
	opts: PubSubOptions
): void {
	for (const service of services) {
		const w: Workers = { busy: 0, down: false, generation: 0 };
		const joinAt = opts.joinAt?.[service.name];
		let connected = joinAt === undefined;
		let buffer: TaskEvent[] = [];
		if (joinAt !== undefined) sim.at(joinAt, () => (connected = true));

		const pump = (): void => {
			while (!w.down && w.busy < service.workers) {
				const event = buffer.shift();
				if (event === undefined) return;
				w.busy++;
				const generation = w.generation;
				sim.after(service.processMs(event), () => {
					if (generation !== w.generation) return;
					w.busy--;
					rec.processed(service.name, event, sim.now);
					pump();
				});
			}
		};

		const disconnect = (): void => {
			rec.dropped(service.name, buffer.length);
			buffer = [];
			connected = false;
		};

		for (const event of events) {
			sim.at(event.publishedAt, () => {
				// If not connected, this message exists nowhere for this subscriber - ever
				if (!connected) return;
				buffer.push(event);
				rec.backlog(service.name, buffer.length);
				if (buffer.length > opts.bufferLimit) {
					// The broker cuts off the slow subscriber, dropping everything piled up - to save itself
					disconnect();
					sim.after(opts.reconnectMs, () => {
						if (!w.down) connected = true;
					});
					return;
				}
				pump();
			});
		}

		scheduleOutages(
			sim,
			opts.outages,
			service.name,
			() => {
				w.down = true;
				w.generation++;
				w.busy = 0;
				disconnect();
			},
			() => {
				w.down = false;
				connected = true;
			}
		);
	}
}

// ── Queue ───────────────────────────────────────────────────────────────────────────────

export interface QueueOptions {
	// 'shared' - a single queue, every service's workers compete on it
	// 'per-service' - fanout exchange: each service has its own queue, every message goes to every queue
	layout: 'shared' | 'per-service';
	// the time between processing done (side effect) and the ack reaching the broker
	ackDelayMs: number;
	outages: Outage[];
	// A service that joins late: its queue is created at this moment - earlier messages never went there
	joinAt?: Record<string, number>;
}

type Unacked = { event: TaskEvent; service: string };

export function runQueue(
	sim: Sim,
	events: TaskEvent[],
	services: ServiceSpec[],
	rec: Recorder,
	opts: QueueOptions
): void {
	type Queue = {
		name: string;
		ready: TaskEvent[];
		unacked: Map<number, Unacked>;
		consumers: ServiceSpec[];
	};
	const queues: Queue[] =
		opts.layout === 'shared'
			? [{ name: 'tasks', ready: [], unacked: new Map(), consumers: services }]
			: services.map((s) => ({ name: s.name, ready: [], unacked: new Map(), consumers: [s] }));
	const workers = new Map<string, Workers>(
		services.map((s) => [s.name, { busy: 0, down: false, generation: 0 }])
	);
	const worker = (name: string): Workers => {
		const w = workers.get(name);
		if (!w) throw new Error(`unknown service ${name}`);
		return w;
	};

	// Round-robin like RabbitMQ: every worker is a consumer (prefetch = 1), and turns rotate -
	// two workers of the same service mean two turns
	const slots = new Map<Queue, ServiceSpec[]>(
		queues.map((q) => [q, q.consumers.flatMap((s) => Array.from({ length: s.workers }, () => s))])
	);
	const turn = new Map<Queue, number>(queues.map((q) => [q, 0]));

	const dispatch = (queue: Queue): boolean => {
		const list = slots.get(queue) ?? [];
		const start = turn.get(queue) ?? 0;
		for (let k = 0; k < list.length; k++) {
			const service = list[(start + k) % list.length];
			if (service === undefined) continue;
			const w = worker(service.name);
			if (w.down || w.busy >= service.workers) continue;
			const event = queue.ready.shift();
			if (event === undefined) return false;
			turn.set(queue, (start + k + 1) % list.length);
			w.busy++;
			queue.unacked.set(event.id, { event, service: service.name });
			const generation = w.generation;
			sim.after(service.processMs(event), () => {
				if (generation !== w.generation) return;
				rec.processed(service.name, event, sim.now);
				sim.after(opts.ackDelayMs, () => {
					if (generation !== w.generation) return;
					queue.unacked.delete(event.id);
					w.busy--;
					pump(queue);
				});
			});
			return true;
		}
		return false;
	};

	const pump = (queue: Queue): void => {
		while (queue.ready.length > 0 && dispatch(queue));
	};

	for (const event of events) {
		sim.at(event.publishedAt, () => {
			for (const queue of queues) {
				const declaredAt = opts.joinAt?.[queue.name];
				if (declaredAt !== undefined && sim.now < declaredAt) continue;
				queue.ready.push(event);
				for (const service of queue.consumers)
					rec.backlog(service.name, queue.ready.length + queue.unacked.size);
				pump(queue);
			}
		});
	}

	for (const service of services) {
		const w = worker(service.name);
		scheduleOutages(
			sim,
			opts.outages,
			service.name,
			() => {
				w.down = true;
				w.generation++;
				w.busy = 0;
				// Connection closed → every unacked message goes back to the queue, in its old place.
				// Those whose side effect had already happened (the ack was on its way) - will be processed again.
				for (const queue of queues) {
					const back = [...queue.unacked.values()].filter((u) => u.service === service.name);
					for (const u of back) queue.unacked.delete(u.event.id);
					queue.ready.unshift(...back.map((u) => u.event).sort((a, b) => a.id - b.id));
					pump(queue);
				}
			},
			() => {
				w.down = false;
				for (const queue of queues) pump(queue);
			}
		);
	}
}

// ── Log ─────────────────────────────────────────────────────────────────────────────────

export interface LogGroup {
	service: ServiceSpec;
	// How many consumers in the group - each processes one message at a time
	consumers: number;
	// A group that joins late: at this moment it starts reading from the start of the log (Kafka's `earliest`)
	joinAt?: number;
}

export interface LogOptions {
	partitions: number;
	// Which partition it goes to: by task id (the same task always in the same partition), or random
	key: 'task' | 'random';
	// How often the consumer commits its offset (Kafka's default auto-commit is 5 seconds)
	commitIntervalMs: number;
	retentionMs: number;
	outages: Outage[];
	random: () => number;
}

type Entry = { event: TaskEvent; appendedAt: number };

export function runLog(
	sim: Sim,
	events: TaskEvent[],
	groups: LogGroup[],
	rec: Recorder,
	opts: LogOptions
): void {
	const log: Entry[][] = Array.from({ length: opts.partitions }, () => []);
	const logStart: number[] = new Array<number>(opts.partitions).fill(0);

	// Retention: old entries are deleted and the start of the log moves forward (offsets do not change)
	const trim = (p: number): number => {
		const entries = log[p] ?? [];
		let start = logStart[p] ?? 0;
		while (start < entries.length && (entries[start]?.appendedAt ?? 0) < sim.now - opts.retentionMs)
			start++;
		logStart[p] = start;
		return start;
	};

	const readers: { pump: () => void; recordLag: () => void }[] = [];

	for (const group of groups) {
		const { service } = group;
		const w: Workers = { busy: 0, down: false, generation: 0 };
		let joined = group.joinAt === undefined;
		// position: which one to read next; done: processed up to where; committed: written to the broker
		let position = new Array<number>(opts.partitions).fill(0);
		let done = new Array<number>(opts.partitions).fill(0);
		let committed = new Array<number>(opts.partitions).fill(0);
		// Consumer i gets the partitions where p % consumers === i - extra consumers sit idle
		const consumers = Array.from({ length: group.consumers }, (_, i) => ({
			partitions: Array.from({ length: opts.partitions }, (_, p) => p).filter(
				(p) => p % group.consumers === i
			),
			busy: false,
			next: 0
		}));

		const pump = (): void => {
			if (!joined || w.down) return;
			for (const consumer of consumers) {
				if (consumer.busy) continue;
				// round-robin over its own partitions - but strictly in order within each partition
				for (let k = 0; k < consumer.partitions.length; k++) {
					const p = consumer.partitions[(consumer.next + k) % consumer.partitions.length];
					if (p === undefined) continue;
					const start = trim(p);
					let at = position[p] ?? 0;
					if (at < start) {
						rec.dropped(service.name, start - at);
						at = start;
					}
					const entry = log[p]?.[at];
					if (entry === undefined) continue;
					position[p] = at + 1;
					consumer.next = (consumer.next + k + 1) % consumer.partitions.length;
					consumer.busy = true;
					const generation = w.generation;
					sim.after(service.processMs(entry.event), () => {
						if (generation !== w.generation) return;
						rec.processed(service.name, entry.event, sim.now);
						done[p] = at + 1;
						consumer.busy = false;
						pump();
					});
					break;
				}
			}
		};
		// Consumer lag: in the log but not yet processed by this group - not stored in the broker, just a distance
		const recordLag = (): void => {
			if (joined)
				rec.backlog(
					service.name,
					log.reduce((sum, entries, p) => sum + entries.length - (done[p] ?? 0), 0)
				);
		};
		readers.push({ pump, recordLag });

		const commitLoop = (): void => {
			if (!w.down && joined) committed = [...done];
			sim.after(opts.commitIntervalMs, commitLoop);
		};
		sim.after(opts.commitIntervalMs, commitLoop);

		if (group.joinAt !== undefined) {
			sim.at(group.joinAt, () => {
				joined = true;
				position = logStart.map((_, p) => trim(p));
				done = [...position];
				committed = [...position];
				pump();
			});
		}

		scheduleOutages(
			sim,
			opts.outages,
			service.name,
			() => {
				w.down = true;
				w.generation++;
				for (const consumer of consumers) consumer.busy = false;
			},
			() => {
				w.down = false;
				// Starting over: from the last committed offset - whatever was processed after it will be processed again
				position = [...committed];
				done = [...committed];
				pump();
			}
		);
	}

	for (const event of events) {
		sim.at(event.publishedAt, () => {
			const p =
				opts.key === 'task'
					? event.taskId % opts.partitions
					: Math.floor(opts.random() * opts.partitions);
			log[p]?.push({ event, appendedAt: sim.now });
			for (const reader of readers) {
				reader.recordLag();
				reader.pump();
			}
		});
	}
}
