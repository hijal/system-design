function fnv1a(key: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function fmix32(input: number): number {
	let h = input;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

export function hash32(key: string): number {
	return fmix32(fnv1a(key));
}

export function hash64(key: string): bigint {
	return (BigInt(hash32(key)) << 32n) | BigInt(hash32(`${key}\u0000`));
}
