export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function zipfSampler(size: number, exponent: number, seed: number): () => number {
	const cumulative = new Float64Array(size);
	let total = 0;
	for (let rank = 0; rank < size; rank++) {
		total += 1 / Math.pow(rank + 1, exponent);
		cumulative[rank] = total;
	}
	const random = mulberry32(seed);
	return () => {
		const target = random() * total;
		let lo = 0;
		let hi = size - 1;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if ((cumulative[mid] ?? 0) < target) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
}

export function keyNames(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}:${i}`);
}

export const pct = (part: number, whole: number, digits = 1): string =>
	`${whole === 0 ? '0' : ((part / whole) * 100).toFixed(digits)}%`;

export const ratio = (value: number): string => `${value.toFixed(2)}x`;

const segmenter = new Intl.Segmenter('bn', { granularity: 'grapheme' });

const cells = (value: string): number => [...segmenter.segment(value)].length;

export const padEnd = (value: string | number, width: number): string => {
	const text = String(value);
	return text + ' '.repeat(Math.max(2, width - cells(text)));
};

export const padLeft = (value: string | number, width: number): string => {
	const text = String(value);
	return ' '.repeat(Math.max(2, width - cells(text))) + text;
};

export function row(columns: [string | number, number][]): string {
	return columns
		.map(([value, width], index) => (index === 0 ? padEnd(value, width) : padLeft(value, width)))
		.join('');
}

export function heading(title: string): void {
	console.log(`\n── ${title} ──`);
}
