import { hashPair } from './hash';

function alpha(registers: number): number {
	if (registers === 16) return 0.673;
	if (registers === 32) return 0.697;
	if (registers === 64) return 0.709;
	return 0.7213 / (1 + 1.079 / registers);
}

export type Estimate = { value: number; raw: number; corrected: boolean };

export class HyperLogLog {
	readonly registers: Uint8Array;

	constructor(readonly precision: number) {
		if (precision < 4 || precision > 18) throw new Error('precision must be 4..18');
		this.registers = new Uint8Array(1 << precision);
	}

	add(key: string): void {
		const [hi, lo] = hashPair(key);
		const index = hi >>> (32 - this.precision);
		const rest = (hi << this.precision) >>> 0;
		const rank = rest !== 0 ? Math.clz32(rest) + 1 : 32 - this.precision + Math.clz32(lo) + 1;
		if (rank > (this.registers[index] ?? 0)) this.registers[index] = rank;
	}

	estimate(): Estimate {
		const m = this.registers.length;
		let sum = 0;
		let zeros = 0;
		for (const register of this.registers) {
			sum += Math.pow(2, -register);
			if (register === 0) zeros++;
		}
		const raw = (alpha(m) * m * m) / sum;
		if (raw <= 2.5 * m && zeros > 0)
			return { value: m * Math.log(m / zeros), raw, corrected: true };
		return { value: raw, raw, corrected: false };
	}

	count(): number {
		return Math.round(this.estimate().value);
	}

	merge(other: HyperLogLog): HyperLogLog {
		if (other.precision !== this.precision) throw new Error('precision mismatch');
		const merged = new HyperLogLog(this.precision);
		for (let i = 0; i < this.registers.length; i++)
			merged.registers[i] = Math.max(this.registers[i] ?? 0, other.registers[i] ?? 0);
		return merged;
	}

	memoryBytes(): number {
		return (this.registers.length * 6) / 8;
	}
}

export const standardError = (precision: number): number => 1.04 / Math.sqrt(1 << precision);
