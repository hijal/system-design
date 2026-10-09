import { latency } from './random';

// A small discrete-event simulator: time doesn't really pass, it just jumps to the next event's time.
// So 10 seconds of cluster runs in under 1 ms, and with a seed it is exactly the same every time.

export interface Timer {
	cancelled: boolean;
}

type Scheduled = { at: number; seq: number; timer: Timer; run: () => void };

export class Sim {
	now = 0;
	private seq = 0;
	private queue: Scheduled[] = [];

	schedule(delay: number, run: () => void): Timer {
		const timer: Timer = { cancelled: false };
		const item: Scheduled = { at: this.now + delay, seq: this.seq++, timer, run };
		// sorted insert - the queue stays small (a few dozen events), so no heap is needed
		let i = this.queue.length;
		while (i > 0) {
			const prev = this.queue[i - 1];
			if (prev === undefined || prev.at < item.at || (prev.at === item.at && prev.seq < item.seq))
				break;
			i--;
		}
		this.queue.splice(i, 0, item);
		return timer;
	}

	// run every event up to until; stop early if stop() returns true
	runUntil(until: number, stop: () => boolean = () => false): void {
		for (;;) {
			const next = this.queue[0];
			if (next === undefined || next.at > until) break;
			this.queue.shift();
			this.now = next.at;
			if (!next.timer.cancelled) next.run();
			if (stop()) return;
		}
		this.now = until;
	}
}

// Network: every message's trip time is random (seeded), and the link between any two nodes
// can be cut. On a cut link messages are silently lost - the sending node learns nothing.
export class Network<M> {
	private cut = new Set<string>();
	private handlers = new Map<string, (message: M, from: string) => void>();

	constructor(
		private readonly sim: Sim,
		private readonly random: () => number,
		private readonly baseMs = 2,
		private readonly meanExtraMs = 2
	) {}

	register(id: string, handler: (message: M, from: string) => void): void {
		this.handlers.set(id, handler);
	}

	send(from: string, to: string, message: M): void {
		if (this.cut.has(`${from}|${to}`)) return;
		const delay = latency(this.random, this.baseMs, this.meanExtraMs);
		this.sim.schedule(delay, () => {
			// lost if the link is still cut at the moment of arrival
			if (this.cut.has(`${from}|${to}`)) return;
			this.handlers.get(to)?.(message, from);
		});
	}

	// cut every link between groups - talk within a group still works
	partition(groups: string[][]): void {
		this.cut.clear();
		for (const a of groups)
			for (const b of groups) {
				if (a === b) continue;
				for (const x of a) for (const y of b) this.cut.add(`${x}|${y}`);
			}
	}

	heal(): void {
		this.cut.clear();
	}
}
