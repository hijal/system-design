import { percentile } from './random';
import type { TaskEvent } from './workload';

// তিনটা broker এর জন্য একই "service" আর একই মাপকাঠি — যাতে তুলনাটা সৎ থাকে।

export interface ServiceSpec {
	name: string;
	workers: number;
	// একটা ঘটনা প্রক্রিয়া করতে কত ms (seed দেওয়া random থেকে)
	processMs: (event: TaskEvent) => number;
}

// Service টা এই সময়ের মধ্যে বন্ধ (deploy বা crash) — তার সব worker একসাথে
export interface Outage {
	service: string;
	from: number;
	to: number;
}

type Processed = { event: TaskEvent; doneAt: number };

// প্রতিটা service এর চোখে কী ঘটল তার খাতা। "প্রক্রিয়া করা" মানে side effect ঘটে গেছে
// (email গেছে, index লেখা হয়েছে) — ack বা commit এর আগেই।
export class Recorder {
	readonly #log = new Map<string, Processed[]>();
	readonly #backlogPeak = new Map<string, number>();
	readonly #dropped = new Map<string, number>();

	processed(service: string, event: TaskEvent, doneAt: number): void {
		const list = this.#log.get(service) ?? [];
		list.push({ event, doneAt });
		this.#log.set(service, list);
	}

	backlog(service: string, size: number): void {
		this.#backlogPeak.set(service, Math.max(this.#backlogPeak.get(service) ?? 0, size));
	}

	// Broker নিজে ফেলে দিল (buffer উপচে পড়া, retention) — "হারানো" এর একটা কারণ
	dropped(service: string, count: number): void {
		this.#dropped.set(service, (this.#dropped.get(service) ?? 0) + count);
	}

	report(service: string, expected: TaskEvent[]): ServiceReport {
		const log = this.#log.get(service) ?? [];
		const firstDone = new Map<number, number>();
		const seen = new Set<number>();
		const maxSeq = new Map<number, number>();
		const disordered = new Set<number>();
		for (const { event, doneAt } of log) {
			if (seen.has(event.id)) continue;
			seen.add(event.id);
			firstDone.set(event.id, doneAt);
			// একই task এর পরের ঘটনা আগেই প্রক্রিয়া হয়ে গেছে? তাহলে এই task এর ক্রম ভাঙল
			const max = maxSeq.get(event.taskId) ?? -1;
			if (event.seq < max) disordered.add(event.taskId);
			else maxSeq.set(event.taskId, event.seq);
		}
		const delays = expected.flatMap((e) => {
			const done = firstDone.get(e.id);
			return done === undefined ? [] : [done - e.publishedAt];
		});
		const wanted = new Set(expected.map((e) => e.id));
		const received = expected.filter((e) => seen.has(e.id)).length;
		return {
			expected: expected.length,
			received,
			lost: expected.length - received,
			duplicates: log.filter((p) => wanted.has(p.event.id)).length - received,
			disorderedTasks: disordered.size,
			p50: percentile(delays, 50),
			p99: percentile(delays, 99),
			max: delays.length ? Math.max(...delays) : 0,
			backlogPeak: this.#backlogPeak.get(service) ?? 0,
			dropped: this.#dropped.get(service) ?? 0
		};
	}
}

export interface ServiceReport {
	expected: number;
	received: number;
	lost: number;
	duplicates: number;
	disorderedTasks: number;
	p50: number;
	p99: number;
	max: number;
	backlogPeak: number;
	dropped: number;
}
