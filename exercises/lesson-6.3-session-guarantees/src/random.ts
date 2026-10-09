// Seeded PRNG (mulberry32) - the same "random" sequence every time, so simulation results match exactly.
export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// One-way network trip time (ms): a minimum + an exponential tail.
// Like real network latency - mostly fast, occasionally very slow.
export function latency(random: () => number, base: number, meanExtra: number): number {
	return base - meanExtra * Math.log(1 - random());
}

export function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}
