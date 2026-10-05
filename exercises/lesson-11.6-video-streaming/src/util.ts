export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const n = (value: number): string => Math.round(value).toLocaleString('en-US');

export const pct = (part: number, whole: number, digits = 1): string =>
	`${whole === 0 ? '0' : ((part / whole) * 100).toFixed(digits)}%`;

export const share = (fraction: number, digits = 2): string =>
	`${(fraction * 100).toFixed(digits)}%`;

export const bytes = (value: number): string => {
	const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
	let v = value;
	let unit = 0;
	while (v >= 1_000 && unit < units.length - 1) {
		v /= 1_000;
		unit++;
	}
	return `${v >= 100 || unit === 0 ? Math.round(v) : v.toFixed(1)} ${units[unit]}`;
};

export const big = (value: number): string => {
	const scales: [number, string][] = [
		[1e12, 'trillion'],
		[1e9, 'billion'],
		[1e6, 'million']
	];
	for (const [size, word] of scales) {
		if (value >= Math.max(size, 1e7)) {
			const v = value / size;
			return `${v >= 1_000 ? n(v) : Number(v.toPrecision(3))} ${word}`;
		}
	}
	return n(value);
};

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

export const env = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
	return value;
};

export function normal(random: () => number): number {
	const u = 1 - random();
	const v = random();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function lognormal(random: () => number, median: number, sigma: number): number {
	return median * Math.exp(sigma * normal(random));
}

export const exponential = (random: () => number, mean: number): number =>
	-Math.log(1 - random()) * mean;

export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
}

export const ms = (value: number): string =>
	value >= 1_000
		? `${(value / 1_000).toFixed(2)} s`
		: value >= 10
			? `${Math.round(value)} ms`
			: `${value.toFixed(2)} ms`;

export function fmix32(input: number): number {
	let h = input >>> 0;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}
