export const n = (value: number): string => Math.round(value).toLocaleString('en-US');

export const num = (value: number): string => {
	const abs = Math.abs(value);
	if (abs >= 100) return n(value);
	if (abs >= 10) return value.toFixed(1);
	return Number(value.toPrecision(3)).toString();
};

export const times = (ratio: number): string => {
	const factor = ratio >= 1 ? ratio : 1 / ratio;
	return `${factor >= 100 ? n(factor) : factor.toFixed(2)}×`;
};

export const factorOff = (mine: number, reference: number): number => {
	const ratio = mine / reference;
	return ratio >= 1 ? ratio : 1 / ratio;
};

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

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
