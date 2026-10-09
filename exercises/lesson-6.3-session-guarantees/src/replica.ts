import { latency } from './random';

// A model of an async replica: every write (LSN) becomes visible some time after it commits on the primary -
// a minimum + an exponential tail, and now and then a "stall" (WAL replay conflicting with a long query,
// vacuum, the network). The replica applies writes **in order**: when one stalls, everything behind it stalls.
// The numbers are an assumed model, not measured from any particular system.

export interface LagModel {
	base: number;
	mean: number;
	stallPerWrite: number;
	stallMs: number;
}

export class Replica {
	private readonly visibleAt: number[] = []; // visibleAt[lsn - 1] = when this LSN becomes visible
	private stalledUntil = 0;

	constructor(
		private readonly model: LagModel,
		private readonly random: () => number
	) {}

	// a write committed on the primary at time `at` (LSN = previous + 1)
	receive(at: number): void {
		if (this.random() < this.model.stallPerWrite) this.stalledUntil = at + this.model.stallMs;
		this.visibleAt.push(
			Math.max(
				at + latency(this.random, this.model.base, this.model.mean),
				this.stalledUntil,
				this.visibleAt[this.visibleAt.length - 1] ?? 0
			)
		);
	}

	// up to which LSN the replica has applied at time `at` (like Postgres's pg_last_wal_replay_lsn())
	replayedAt(at: number): number {
		let lo = 0;
		let hi = this.visibleAt.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((this.visibleAt[mid] ?? Infinity) <= at) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}
}

export function shuffled<T>(items: T[], random: () => number): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const a = copy[i];
		const b = copy[j];
		if (a === undefined || b === undefined) continue;
		copy[i] = b;
		copy[j] = a;
	}
	return copy;
}
