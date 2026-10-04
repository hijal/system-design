export class TokenBucket {
	private tokens: number;
	private updated: number;

	constructor(
		readonly rate: number,
		readonly capacity: number,
		start = 0
	) {
		this.tokens = capacity;
		this.updated = start;
	}

	private refill(now: number): void {
		if (now > this.updated) {
			this.tokens = Math.min(
				this.capacity,
				this.tokens + ((now - this.updated) / 1_000) * this.rate
			);
			this.updated = now;
		}
	}

	peek(now: number): number {
		this.refill(now);
		return this.tokens;
	}

	overwrite(now: number, tokens: number): void {
		this.refill(now);
		this.tokens = tokens;
	}

	take(now: number, count = 1): number {
		this.refill(now);
		const granted = Math.min(count, Math.floor(this.tokens));
		this.tokens -= granted;
		return granted;
	}

	retryAfterMs(now: number): number {
		this.refill(now);
		return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1_000);
	}
}

interface Event {
	at: number;
	seq: number;
	run: () => void;
}

export class Scheduler {
	private heap: Event[] = [];
	private seq = 0;
	now = 0;

	at(time: number, run: () => void): void {
		const event: Event = { at: time, seq: this.seq++, run };
		const heap = this.heap;
		heap.push(event);
		let i = heap.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			const p = heap[parent];
			if (p === undefined || before(p, event)) break;
			heap[i] = p;
			i = parent;
		}
		heap[i] = event;
	}

	private pop(): Event | undefined {
		const heap = this.heap;
		const top = heap[0];
		const last = heap.pop();
		if (top === undefined || last === undefined || heap.length === 0) return top;
		let i = 0;
		for (;;) {
			const left = 2 * i + 1;
			const right = left + 1;
			let smallest = i;
			let value = last;
			const l = heap[left];
			const r = heap[right];
			if (l !== undefined && before(l, value)) {
				smallest = left;
				value = l;
			}
			if (r !== undefined && before(r, value)) smallest = right;
			if (smallest === i) break;
			const child = heap[smallest];
			if (child === undefined) break;
			heap[i] = child;
			i = smallest;
		}
		heap[i] = last;
		return top;
	}

	run(): void {
		for (let event = this.pop(); event !== undefined; event = this.pop()) {
			this.now = event.at;
			event.run();
		}
	}
}

const before = (a: Event, b: Event): boolean => a.at < b.at || (a.at === b.at && a.seq < b.seq);
