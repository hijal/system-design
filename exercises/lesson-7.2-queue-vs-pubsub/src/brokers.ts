import { type Outage, type Recorder, type ServiceSpec } from './model';
import type { Sim } from './sim';
import type { TaskEvent } from './workload';

// Lesson 7.2 — তিন ধরনের broker, প্রতিটা তার আসল রূপের মূল আচরণটুকু নিয়ে:
//
//   runPubSub  — Redis Pub/Sub এর মতো: যে এই মুহূর্তে connected, সে পায়; কিছু জমা থাকে না
//   runQueue   — RabbitMQ এর queue এর মতো: message জমা থাকে, একজন consumer পায়, ack এ মুছে যায়
//   runLog     — Kafka / Redis Streams এর মতো: append-only log, partition, consumer group আর offset
//
// প্রতিটা service এর worker রা ঘটনা প্রক্রিয়া করে; "প্রক্রিয়া শেষ" মানে side effect ঘটে গেছে।
// Outage এর মুহূর্তে যে কাজ মাঝপথে ছিল, সেটা বাতিল (side effect হয়নি)।

interface Workers {
	busy: number;
	down: boolean;
	// Outage এ বাড়ে — পুরনো generation এর চলমান কাজ শেষ হলেও গোনা হয় না
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
	// Subscriber এর জন্য broker এ জমে থাকা message এর সীমা (Redis এর client-output-buffer-limit এর মতো)
	bufferLimit: number;
	reconnectMs: number;
	outages: Outage[];
	// দেরিতে subscribe করা service: এই মুহূর্তের আগে সে connected ছিল না
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
				// Connected না থাকলে এই message এই subscriber এর জন্য কোথাও নেই — কখনো না
				if (!connected) return;
				buffer.push(event);
				rec.backlog(service.name, buffer.length);
				if (buffer.length > opts.bufferLimit) {
					// Broker ধীর subscriber কে কেটে দেয়, জমা সব ফেলে দিয়ে — নিজেকে বাঁচাতে
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
	// 'shared' — একটাই queue, সব service এর worker তাতে প্রতিযোগিতা করে
	// 'per-service' — fanout exchange: প্রতিটা service এর নিজের queue, প্রতিটা message সব queue তে
	layout: 'shared' | 'per-service';
	// প্রক্রিয়া শেষ (side effect) আর broker এর কাছে ack পৌঁছানোর মাঝের সময়
	ackDelayMs: number;
	outages: Outage[];
	// দেরিতে যোগ দেওয়া service: তার queue এই মুহূর্তে তৈরি হয় — আগের message সেখানে কখনো যায়নি
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

	// RabbitMQ এর মতো round-robin: প্রতিটা worker একটা consumer (prefetch = 1), আর পালা ঘোরে —
	// একই service এর দুটো worker মানে দুটো পালা
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
				// Connection বন্ধ → ack না পাওয়া সব message আবার queue তে, আগের জায়গায়।
				// এর মধ্যে যেগুলোর side effect হয়ে গিয়েছিল (ack পথে ছিল) — সেগুলো আবার প্রক্রিয়া হবে।
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
	// Group এ কয়টা consumer — প্রতিটা একসাথে একটাই message প্রক্রিয়া করে
	consumers: number;
	// দেরিতে যোগ দেওয়া group: এই মুহূর্তে log এর শুরু থেকে পড়া শুরু করে (Kafka এর `earliest`)
	joinAt?: number;
}

export interface LogOptions {
	partitions: number;
	// কোন partition এ যাবে: task id দিয়ে (একই task সবসময় একই partition), নাকি এলোমেলো
	key: 'task' | 'random';
	// Consumer কত পর পর offset commit করে (Kafka এর default auto-commit ৫ সেকেন্ড)
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

	// Retention: পুরনো entry মুছে log এর শুরু সামনে সরে (offset গুলো বদলায় না)
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
		// position: পরের কোনটা পড়ব; done: কোন পর্যন্ত প্রক্রিয়া শেষ; committed: broker এ লেখা
		let position = new Array<number>(opts.partitions).fill(0);
		let done = new Array<number>(opts.partitions).fill(0);
		let committed = new Array<number>(opts.partitions).fill(0);
		// Consumer i পায় সেই partition গুলো যাদের p % consumers === i — বাড়তি consumer বসে থাকে
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
				// নিজের partition গুলো ঘুরে ঘুরে — কিন্তু প্রতিটা partition এর ভেতরে কড়া ক্রমে
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
		// Consumer lag: log এ আছে কিন্তু এই group এখনো প্রক্রিয়া করেনি — broker এ জমা না, শুধু একটা দূরত্ব
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
				// নতুন করে শুরু: শেষ commit করা offset থেকে — তার পরে যা প্রক্রিয়া হয়েছিল, আবার হবে
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
