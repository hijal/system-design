import { hash32, moduloShard } from './hash';

// Lesson 5.8 §১.৪ আর §১.৭ — database ছাড়া, শুধু হিসাব (deterministic, seed দেওয়া):
//   ক. কোন shard key তে write কোথায় জমে (hot shard)
//   খ. shard ৩ থেকে ৪ করলে কত data সরাতে হয় — hash % N বনাম consistent hashing

const SHARDS = 4;
const WRITES = 1_000_000;
const WORKSPACES = 1_000;
const PROJECTS_PER_WORKSPACE = 20;
const BIG_WORKSPACE = 7;
const BIG_SHARE = 0.4;

// ছোট একটা seeded PRNG (mulberry32) — প্রতিবার একই "random" ক্রম, যাতে ফল মেলানো যায়
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Write = { taskId: number; workspaceId: number; projectId: number; month: number };

// আজকের ১০ লাখ write — ৪০% একটা বিশাল workspace থেকে, বাকিটা ছড়ানো। সব এই মাসের (১২)।
function todaysWrites(): Write[] {
	const random = mulberry32(42);
	return Array.from({ length: WRITES }, (_unused, i) => {
		const workspaceId =
			random() < BIG_SHARE ? BIG_WORKSPACE : 1 + Math.floor(random() * WORKSPACES);
		const projectId = workspaceId * 100 + Math.floor(random() * PROJECTS_PER_WORKSPACE);
		return { taskId: 10_000_000 + i, workspaceId, projectId, month: 12 };
	});
}

type KeyStrategy = { label: string; shardOf: (w: Write) => number };

const strategies: KeyStrategy[] = [
	{ label: 'hash(workspaceId)', shardOf: (w) => moduloShard(`ws:${w.workspaceId}`, SHARDS) },
	{ label: 'hash(taskId)', shardOf: (w) => moduloShard(`task:${w.taskId}`, SHARDS) },
	// Range by time: মাস ১–৩ → shard0, ৪–৬ → shard1, … — নতুন data সবসময় শেষ shard এ
	{ label: 'range(createdAt) — ত্রৈমাসিক', shardOf: (w) => Math.floor((w.month - 1) / 3) },
	{
		label: 'hash(workspaceId, projectId)',
		shardOf: (w) => moduloShard(`ws:${w.workspaceId}:p:${w.projectId}`, SHARDS)
	}
];

function writeDistribution(writes: Write[]): void {
	console.log(
		`\nক. আজকের ${WRITES.toLocaleString('en-US')}টা write, ${SHARDS}টা shard — কোন shard key তে কোথায় জমে?`
	);
	console.log('   (৪০% write একটা workspace থেকে — একটা বিশাল enterprise customer)\n');
	console.log(
		`   ${'shard key'.padEnd(30)} ${'প্রতিটা shard এ write এর ভাগ'.padEnd(32)} সবচেয়ে ব্যস্ত   workspace ${BIG_WORKSPACE} এর data কয়টা shard এ`
	);
	for (const strategy of strategies) {
		const counts = new Array<number>(SHARDS).fill(0);
		const bigShards = new Set<number>();
		for (const w of writes) {
			const shard = strategy.shardOf(w);
			counts[shard] = (counts[shard] ?? 0) + 1;
			if (w.workspaceId === BIG_WORKSPACE) bigShards.add(shard);
		}
		const shares = counts.map((c) => `${((c / WRITES) * 100).toFixed(0).padStart(3)}%`).join(' ');
		const busiest = Math.max(...counts) / WRITES;
		console.log(
			`   ${strategy.label.padEnd(30)} ${shares.padEnd(32)} ${`${(busiest * 100).toFixed(0)}%`.padStart(8)}        ${bigShards.size}টা`
		);
	}
	console.log(`\n   (সমান ভাগ হলে প্রতিটা shard এ ${(100 / SHARDS).toFixed(0)}%)`);
}

// Consistent hashing — এখানে শুধু ধারণা দেখানোর মতো ছোট একটা রূপ; পূর্ণ গভীরতা Lesson 10.1 এ।
// প্রতিটা shard কে একটা বৃত্তের (ring) উপর অনেকগুলো বিন্দুতে বসানো (virtual node); একটা key
// যায় বৃত্তে তার ঘড়ির কাঁটার দিকে পরের বিন্দুর shard এ।
function buildRing(shardCount: number, virtualNodes = 200): { point: number; shard: number }[] {
	const ring: { point: number; shard: number }[] = [];
	for (let shard = 0; shard < shardCount; shard++) {
		for (let v = 0; v < virtualNodes; v++)
			ring.push({ point: hash32(`shard${shard}#vn${v}`), shard });
	}
	return ring.sort((a, b) => a.point - b.point);
}

function ringShard(ring: { point: number; shard: number }[], key: string): number {
	const h = hash32(key);
	let lo = 0;
	let hi = ring.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((ring[mid]?.point ?? 0) < h) lo = mid + 1;
		else hi = mid;
	}
	return (ring[lo] ?? ring[0])?.shard ?? 0;
}

function resharding(): void {
	const KEYS = 100_000;
	const keys = Array.from({ length: KEYS }, (_unused, i) => `ws:${i + 1}`);
	console.log(
		`\nখ. Shard ৩ থেকে ৪ করা — ${KEYS.toLocaleString('en-US')}টা workspace এর কতগুলো অন্য shard এ সরাতে হবে?\n`
	);

	const movedModulo = keys.filter((k) => moduloShard(k, 3) !== moduloShard(k, 4)).length;
	const ring3 = buildRing(3);
	const ring4 = buildRing(4);
	const movedRing = keys.filter((k) => ringShard(ring3, k) !== ringShard(ring4, k)).length;
	const pct = (n: number): string => `${((n / KEYS) * 100).toFixed(1)}%`;

	console.log(
		`   hash % N              ${movedRing > 0 ? pct(movedModulo).padStart(6) : ''}   (${movedModulo.toLocaleString('en-US')}টা)`
	);
	console.log(
		`   consistent hashing    ${pct(movedRing).padStart(6)}   (${movedRing.toLocaleString('en-US')}টা)`
	);
	console.log(`   আদর্শ (শুধু নতুন shard এর ভাগটুকু = ১/৪)   ${pct(KEYS / 4).padStart(6)}`);
}

function main(): void {
	writeDistribution(todaysWrites());
	resharding();
	console.log('');
}

main();
