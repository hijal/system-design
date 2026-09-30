import { hashPair } from './hash';

export class CountMinSketch {
	private readonly counters: Uint32Array;

	constructor(
		readonly width: number,
		readonly depth: number
	) {
		this.counters = new Uint32Array(width * depth);
	}

	add(key: string, amount = 1): void {
		const [h1, h2] = hashPair(key);
		for (let row = 0; row < this.depth; row++) {
			const index = row * this.width + ((h1 + row * h2) % this.width);
			this.counters[index] = (this.counters[index] ?? 0) + amount;
		}
	}

	estimate(key: string): number {
		const [h1, h2] = hashPair(key);
		let best = Number.POSITIVE_INFINITY;
		for (let row = 0; row < this.depth; row++) {
			const value = this.counters[row * this.width + ((h1 + row * h2) % this.width)] ?? 0;
			if (value < best) best = value;
		}
		return best;
	}

	memoryBytes(): number {
		return this.counters.byteLength;
	}
}
