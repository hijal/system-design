export const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const keyspace = (length: number): number => 62 ** length;

export function encode(value: number, width = 0): string {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`base62: ${value}`);
	let rest = value;
	let out = '';
	do {
		out = ALPHABET.charAt(rest % 62) + out;
		rest = Math.floor(rest / 62);
	} while (rest > 0);
	return out.padStart(width, '0');
}

export function decode(code: string): number {
	let value = 0;
	for (const char of code) {
		const digit = ALPHABET.indexOf(char);
		if (digit < 0) throw new RangeError(`base62: "${char}"`);
		value = value * 62 + digit;
	}
	return value;
}

export const isBase62 = (text: string): boolean => /^[0-9a-zA-Z]+$/.test(text);
