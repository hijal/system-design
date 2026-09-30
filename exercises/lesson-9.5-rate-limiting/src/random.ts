export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

export const ms = (value: number): string =>
	value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;

export const pad = (value: string | number, width: number): string => String(value).padStart(width);

const segmenter = new Intl.Segmenter('bn', { granularity: 'grapheme' });

export const cells = (value: string): number => [...segmenter.segment(value)].length;

export const padEnd = (value: string | number, width: number): string => {
	const text = String(value);
	return text + ' '.repeat(Math.max(1, width - cells(text)));
};

export const padLeft = (value: string | number, width: number): string => {
	const text = String(value);
	return ' '.repeat(Math.max(1, width - cells(text))) + text;
};

export const sleep = (msValue: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, msValue));
