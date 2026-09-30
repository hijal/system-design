const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

const rotl = (value: number, bits: number): number => (value << bits) | (value >>> (32 - bits));

function scramble(block: number): number {
	return Math.imul(rotl(Math.imul(block, C1), 15), C2);
}

export function murmur3(key: string, seed: number): number {
	let h = seed >>> 0;
	const length = key.length;
	const tail = length & ~3;
	for (let i = 0; i < tail; i += 4) {
		const block =
			(key.charCodeAt(i) & 0xff) |
			((key.charCodeAt(i + 1) & 0xff) << 8) |
			((key.charCodeAt(i + 2) & 0xff) << 16) |
			((key.charCodeAt(i + 3) & 0xff) << 24);
		h ^= scramble(block);
		h = rotl(h, 13);
		h = (Math.imul(h, 5) + 0xe6546b64) | 0;
	}
	let rest = 0;
	const remaining = length & 3;
	if (remaining >= 3) rest ^= (key.charCodeAt(tail + 2) & 0xff) << 16;
	if (remaining >= 2) rest ^= (key.charCodeAt(tail + 1) & 0xff) << 8;
	if (remaining >= 1) {
		rest ^= key.charCodeAt(tail) & 0xff;
		h ^= scramble(rest);
	}
	h ^= length;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

export function hashPair(key: string): [number, number] {
	return [murmur3(key, 0x9747b28c), murmur3(key, 0x5bd1e995)];
}
