export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function hashUnit(value: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

export function normal(random: () => number): number {
	const u = 1 - random();
	const v = random();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function lognormal(random: () => number, median: number, sigma: number): number {
	return median * Math.exp(sigma * normal(random));
}

export function binomial(random: () => number, trials: number, p: number): number {
	const mean = trials * p;
	if (mean < 40) {
		const limit = Math.exp(-mean);
		let k = 0;
		let product = random();
		while (product > limit) {
			k++;
			product *= random();
		}
		return Math.min(k, trials);
	}
	const sample = Math.round(mean + Math.sqrt(mean * (1 - p)) * normal(random));
	return Math.max(0, Math.min(trials, sample));
}

export function zScore(badA: number, totalA: number, badB: number, totalB: number): number {
	if (totalA === 0 || totalB === 0) return 0;
	const pooled = (badA + badB) / (totalA + totalB);
	const se = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
	if (se === 0) return 0;
	return (badA / totalA - badB / totalB) / se;
}

export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
}

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

export const n = (value: number): string => Math.round(value).toLocaleString('en-US');

export const pct = (part: number, whole: number, digits = 1): string =>
	`${whole === 0 ? '0' : ((part / whole) * 100).toFixed(digits)}%`;

export const minutes = (seconds: number): string => {
	if (seconds < 60) return `${Math.round(seconds)} s`;
	if (seconds < 3_600) return `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)} মি`;
	return `${(seconds / 3_600).toFixed(1)} ঘ`;
};

export const ms = (value: number): string =>
	value >= 1_000 ? `${(value / 1_000).toFixed(2)} s` : `${Math.round(value)} ms`;

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

export const env = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`${name} একটা সংখ্যা হতে হবে, পাওয়া গেল "${raw}"`);
	return value;
};
