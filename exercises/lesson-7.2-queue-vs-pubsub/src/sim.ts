// A small discrete-event simulator: time doesn't really pass, it just jumps to the next event's time.
// So two minutes of TaskFlow run in a blink, and with a seed it is exactly the same every time.

type Scheduled = { at: number; seq: number; run: () => void };

export class Sim {
	now = 0;
	#seq = 0;
	readonly #queue: Scheduled[] = [];

	at(time: number, run: () => void): void {
		const item: Scheduled = { at: Math.max(time, this.now), seq: this.#seq++, run };
		// binary search insert — thousands of events wait here at once
		let lo = 0;
		let hi = this.#queue.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const other = this.#queue[mid];
			if (
				other !== undefined &&
				(other.at < item.at || (other.at === item.at && other.seq < item.seq))
			)
				lo = mid + 1;
			else hi = mid;
		}
		this.#queue.splice(lo, 0, item);
	}

	after(delay: number, run: () => void): void {
		this.at(this.now + delay, run);
	}

	run(until: number): void {
		for (;;) {
			const next = this.#queue[0];
			if (next === undefined || next.at > until) break;
			this.#queue.shift();
			this.now = next.at;
			next.run();
		}
		this.now = until;
	}
}
