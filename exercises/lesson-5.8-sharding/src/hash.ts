// The hash for shard routing — it needs two things:
//   1. Stable: the same key always gives the same number — on any app instance, at any time
//   2. Well mixed: nearly identical keys ("shard3#vn1", "shard3#vn2") must give completely different numbers
//
// FNV-1a alone gives (1), but is weak at (2) on short, nearly identical strings — measured in this exercise:
// on the consistent hashing ring one shard was getting 47% of keys, another 12%. So at the end MurmurHash3's
// finalizer (fmix32) mixes the bits further. (Production usually uses a tested hash like MurmurHash3
// or xxHash.)

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

// the simplest routing: hash % number of shards
export function moduloShard(key: string, shardCount: number): number {
	return hash32(key) % shardCount;
}
