// Shard routing এর hash — দুটো জিনিস লাগে:
//   ১. Stable: একই key সবসময় একই সংখ্যা — যেকোনো app instance এ, যেকোনো সময়
//   ২. ভালোভাবে মেশানো: প্রায়-একই key ("shard3#vn1", "shard3#vn2") ও যেন সম্পূর্ণ ভিন্ন সংখ্যা দেয়
//
// FNV-1a একা (১) দেয়, কিন্তু ছোট আর প্রায়-একই string এ (২) দুর্বল — এই exercise এ মাপা:
// consistent hashing ring এ একটা shard ৪৭% key পাচ্ছিল, আরেকটা ১২%। তাই শেষে MurmurHash3
// এর finalizer (fmix32) দিয়ে bit গুলো আরও মেশানো হয়। (Production এ সাধারণত MurmurHash3,
// xxHash এর মতো পরীক্ষিত hash ব্যবহার করা হয়।)

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

// সবচেয়ে সরল routing: hash % shard এর সংখ্যা
export function moduloShard(key: string, shardCount: number): number {
	return hash32(key) % shardCount;
}
