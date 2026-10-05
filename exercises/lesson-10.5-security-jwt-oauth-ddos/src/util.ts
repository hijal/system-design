export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function lognormal(random: () => number, median: number, sigma: number): number {
	const u = 1 - random();
	const v = random();
	return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
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

export const duration = (minutes: number): string => {
	if (minutes < 1) return `${Math.round(minutes * 60)} s`;
	if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
	if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
	return `${(minutes / 1_440).toFixed(1)} days`;
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

export function shuffle<T>(items: T[], random: () => number): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const a = items[i];
		const b = items[j];
		if (a === undefined || b === undefined) continue;
		items[i] = b;
		items[j] = a;
	}
	return items;
}
