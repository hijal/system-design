export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function normal(random: () => number): number {
	const u = 1 - random();
	const v = random();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
}

export const n = (value: number): string => Math.round(value).toLocaleString('en-US');

export const usd = (value: number): string => {
	const sign = value < 0 ? '−' : '';
	const abs = Math.abs(value);
	if (abs >= 100) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
	if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
	if (abs === 0) return '$0';
	if (abs >= 0.01) return `${sign}$${abs.toFixed(3)}`;
	return `${sign}$${abs.toFixed(Math.min(10, 1 - Math.floor(Math.log10(abs))))}`;
};

export const pct = (part: number, whole: number, digits = 1): string =>
	`${whole === 0 ? '0' : ((part / whole) * 100).toFixed(digits)}%`;

export const tb = (gb: number): string =>
	gb >= 1_000 ? `${(gb / 1_000).toFixed(1)} TB` : `${Math.round(gb).toLocaleString('en-US')} GB`;

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
