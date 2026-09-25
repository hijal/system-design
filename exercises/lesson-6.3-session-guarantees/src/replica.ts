import { latency } from './random';

// একটা async replica এর মডেল: প্রতিটা লেখা (LSN) primary তে commit হওয়ার কিছু পরে দেখা যায় —
// ন্যূনতম + exponential লেজ, আর মাঝে মাঝে "আটকে যাওয়া" (লম্বা query এর সাথে WAL replay এর বিরোধ,
// vacuum, network)। Replica লেখা **ক্রমানুসারে** প্রয়োগ করে: একটা আটকালে পেছনের সবাই আটকায়।
// সংখ্যাগুলো ধরে নেওয়া মডেল, কোনো নির্দিষ্ট system থেকে মাপা না।

export interface LagModel {
	base: number;
	mean: number;
	stallPerWrite: number;
	stallMs: number;
}

export class Replica {
	private readonly visibleAt: number[] = []; // visibleAt[lsn - 1] = এই LSN কখন দেখা যায়
	private stalledUntil = 0;

	constructor(
		private readonly model: LagModel,
		private readonly random: () => number
	) {}

	// primary তে `at` সময়ে একটা লেখা commit হলো (LSN = আগের + 1)
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

	// `at` সময়ে replica কোন LSN পর্যন্ত প্রয়োগ করেছে (Postgres এর pg_last_wal_replay_lsn() এর মতো)
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
