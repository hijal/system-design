export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function exponential(random: () => number, mean: number): number {
	return -Math.log(1 - random()) * mean;
}

export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
}

export const n = (value: number): string => Math.round(value).toLocaleString('en-US');

export const pct = (part: number, whole: number, digits = 1): string =>
	`${whole === 0 ? '0' : ((part / whole) * 100).toFixed(digits)}%`;

export const ms = (value: number): string =>
	value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(0)} ms`;

const segmenter = new Intl.Segmenter('bn', { granularity: 'grapheme' });

const cells = (value: string): number => [...segmenter.segment(value)].length;

export const padEnd = (value: string | number, width: number): string => {
	const text = String(value);
	return text + ' '.repeat(Math.max(1, width - cells(text)));
};

export const padLeft = (value: string | number, width: number): string => {
	const text = String(value);
	return ' '.repeat(Math.max(1, width - cells(text))) + text;
};

export function row(columns: [string | number, number][]): string {
	return columns
		.map(([value, width], index) => (index === 0 ? padEnd(value, width) : padLeft(value, width)))
		.join('');
}

export function heading(title: string): void {
	console.log(`\n── ${title} ──`);
}

export function lognormal(random: () => number, median: number, sigma: number): number {
	const u = 1 - random();
	const v = random();
	return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

export function zipfSampler(size: number, exponent: number, random: () => number): () => number {
	const cumulative = new Float64Array(size);
	let total = 0;
	for (let rank = 0; rank < size; rank++) {
		total += 1 / Math.pow(rank + 1, exponent);
		cumulative[rank] = total;
	}
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

export const bytes = (value: number): string => {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = value;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit++;
	}
	return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
};
