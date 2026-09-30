import { hashPair } from './hash';

export const optimalHashes = (bitsPerItem: number): number =>
	Math.max(1, Math.round(bitsPerItem * Math.LN2));

export const bitsForRate = (capacity: number, falsePositiveRate: number): number =>
	Math.ceil((-capacity * Math.log(falsePositiveRate)) / (Math.LN2 * Math.LN2));

export const theoreticalRate = (bits: number, items: number, hashes: number): number =>
	Math.pow(1 - Math.exp((-hashes * items) / bits), hashes);

export interface MembershipFilter {
	readonly label: string;
	add(key: string): void;
	has(key: string): boolean;
	memoryBits(): number;
}

function forEachPosition(key: string, size: number, hashes: number, visit: (i: number) => void) {
	const [h1, h2] = hashPair(key);
	for (let i = 0; i < hashes; i++) visit((h1 + i * h2) % size);
}

export class BloomFilter implements MembershipFilter {
	readonly label = 'bloom';
	private readonly bits: Uint8Array;

	constructor(
		readonly size: number,
		readonly hashes: number
	) {
		this.bits = new Uint8Array(Math.ceil(size / 8));
	}

	static forCapacity(capacity: number, falsePositiveRate: number): BloomFilter {
		const size = bitsForRate(capacity, falsePositiveRate);
		return new BloomFilter(size, optimalHashes(size / capacity));
	}

	add(key: string): void {
		forEachPosition(key, this.size, this.hashes, (i) => {
			this.bits[i >>> 3] = (this.bits[i >>> 3] ?? 0) | (1 << (i & 7));
		});
	}

	has(key: string): boolean {
		const [h1, h2] = hashPair(key);
		for (let i = 0; i < this.hashes; i++) {
			const position = (h1 + i * h2) % this.size;
			if (((this.bits[position >>> 3] ?? 0) & (1 << (position & 7))) === 0) return false;
		}
		return true;
	}

	clearBitsOf(key: string): void {
		forEachPosition(key, this.size, this.hashes, (i) => {
			this.bits[i >>> 3] = (this.bits[i >>> 3] ?? 0) & ~(1 << (i & 7));
		});
	}

	fillRatio(): number {
		let set = 0;
		for (const byte of this.bits) {
			let b = byte;
			while (b !== 0) {
				b &= b - 1;
				set++;
			}
		}
		return set / this.size;
	}

	memoryBits(): number {
		return this.size;
	}
}

export class CountingBloomFilter implements MembershipFilter {
	readonly label = 'counting bloom';
	private readonly counters: Uint8Array;
	saturated = 0;

	constructor(
		readonly size: number,
		readonly hashes: number
	) {
		this.counters = new Uint8Array(size);
	}

	add(key: string): void {
		forEachPosition(key, this.size, this.hashes, (i) => {
			const value = this.counters[i] ?? 0;
			if (value === 15) this.saturated++;
			else this.counters[i] = value + 1;
		});
	}

	remove(key: string): void {
		forEachPosition(key, this.size, this.hashes, (i) => {
			const value = this.counters[i] ?? 0;
			if (value > 0 && value < 15) this.counters[i] = value - 1;
		});
	}

	has(key: string): boolean {
		const [h1, h2] = hashPair(key);
		for (let i = 0; i < this.hashes; i++) {
			if ((this.counters[(h1 + i * h2) % this.size] ?? 0) === 0) return false;
		}
		return true;
	}

	memoryBits(): number {
		return this.size * 4;
	}
}

export function falsePositives(
	filter: Pick<MembershipFilter, 'has'>,
	prefix: string,
	probes: number
): number {
	let hits = 0;
	for (let i = 0; i < probes; i++) if (filter.has(`${prefix}:${i}`)) hits++;
	return hits;
}
