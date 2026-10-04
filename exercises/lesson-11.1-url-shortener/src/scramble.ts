function fmix32(input: number): number {
	let h = input >>> 0;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

export class Permutation {
	private readonly half: number;
	private readonly mask: number;
	private readonly modulus: number;
	private readonly keys: readonly number[];
	walks = 0;

	constructor(
		readonly domain: number,
		secret: number,
		rounds = 4
	) {
		let bits = 2;
		while (2 ** bits < domain) bits += 2;
		this.half = bits / 2;
		this.modulus = 2 ** this.half;
		this.mask = this.modulus - 1;
		this.keys = Array.from({ length: rounds }, (_, i) =>
			fmix32(secret + Math.imul(i + 1, 0x9e3779b9))
		);
	}

	private round(x: number): number {
		let left = Math.floor(x / this.modulus);
		let right = x % this.modulus;
		for (const key of this.keys) {
			const next = (left ^ (fmix32(right ^ key) & this.mask)) >>> 0;
			left = right;
			right = next;
		}
		return left * this.modulus + right;
	}

	apply(x: number): number {
		if (!Number.isSafeInteger(x) || x < 0 || x >= this.domain)
			throw new RangeError(`permutation: ${x}`);
		let y = this.round(x);
		while (y >= this.domain) {
			this.walks++;
			y = this.round(y);
		}
		return y;
	}
}
