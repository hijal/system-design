import { env } from './util';

export const ACCOUNTS = env('ACCOUNTS', 500_000_000);
export const ALPHA = env('ALPHA', 1.2);
export const CAP = env('CAP', 150_000_000);
export const MEAN_FOLLOWS = env('MEAN_FOLLOWS', 200);

export interface Bin {
	count: number;
	followers: number;
	firstRank: number;
}

function binsFor(scale: number): Bin[] {
	const bins: Bin[] = [];
	let start = 1;
	while (start <= ACCOUNTS) {
		const end = Math.min(ACCOUNTS, Math.max(start, Math.floor(start * 1.05)));
		const mid = Math.sqrt(start * (end + 1));
		bins.push({
			count: end - start + 1,
			followers: Math.min(CAP, scale * Math.pow(ACCOUNTS / mid, 1 / ALPHA)),
			firstRank: start
		});
		start = end + 1;
	}
	return bins;
}

const meanOf = (bins: readonly Bin[]): number =>
	bins.reduce((sum, b) => sum + b.count * b.followers, 0) / ACCOUNTS;

function calibrate(): { scale: number; bins: Bin[] } {
	let lo = 0.001;
	let hi = 10_000;
	for (let i = 0; i < 80; i++) {
		const mid = Math.sqrt(lo * hi);
		if (meanOf(binsFor(mid)) < MEAN_FOLLOWS) lo = mid;
		else hi = mid;
	}
	return { scale: lo, bins: binsFor(lo) };
}

export const { scale: SCALE, bins: BINS } = calibrate();

export const followersAtRank = (rank: number): number =>
	Math.min(CAP, SCALE * Math.pow(ACCOUNTS / rank, 1 / ALPHA));

export function followersAtQuantile(q: number): number {
	return followersAtRank(Math.max(1, Math.round((1 - q) * ACCOUNTS)));
}

export function edgesAbove(threshold: number): { accounts: number; edges: number } {
	let accounts = 0;
	let edges = 0;
	for (const b of BINS) {
		if (b.followers > threshold) {
			accounts += b.count;
			edges += b.count * b.followers;
		}
	}
	return { accounts, edges };
}

export const totalEdges = (): number => BINS.reduce((sum, b) => sum + b.count * b.followers, 0);
