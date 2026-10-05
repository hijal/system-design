import { hash32, moduloShard } from './hash';

// Lesson 5.8 §1.4 and §1.7 — no database, just arithmetic (deterministic, seeded):
//   a. where writes pile up under each shard key (hot shard)
//   b. how much data has to move going from 3 to 4 shards — hash % N vs consistent hashing

const SHARDS = 4;
const WRITES = 1_000_000;
const WORKSPACES = 1_000;
const PROJECTS_PER_WORKSPACE = 20;
const BIG_WORKSPACE = 7;
const BIG_SHARE = 0.4;

// a small seeded PRNG (mulberry32) — the same "random" sequence every time, so the results can be compared
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

// today's 1,000,000 writes — 40% from one huge workspace, the rest spread out. All in this month (12).
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
	// Range by time: months 1–3 → shard0, 4–6 → shard1, … — new data always on the last shard
	{ label: 'range(createdAt) — quarterly', shardOf: (w) => Math.floor((w.month - 1) / 3) },
	{
		label: 'hash(workspaceId, projectId)',
		shardOf: (w) => moduloShard(`ws:${w.workspaceId}:p:${w.projectId}`, SHARDS)
	}
];

function writeDistribution(writes: Write[]): void {
	console.log(
		`\na. Today's ${WRITES.toLocaleString('en-US')} writes, ${SHARDS} shards — where do writes pile up under each shard key?`
	);
	console.log('   (40% of writes come from one workspace — a huge enterprise customer)\n');
	console.log(
		`   ${'shard key'.padEnd(30)} ${'share of writes per shard'.padEnd(32)} busiest   shards holding workspace ${BIG_WORKSPACE}'s data`
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
			`   ${strategy.label.padEnd(30)} ${shares.padEnd(32)} ${`${(busiest * 100).toFixed(0)}%`.padStart(8)}        ${bigShards.size}`
		);
	}
	console.log(`\n   (an even split would be ${(100 / SHARDS).toFixed(0)}% per shard)`);
}

// Consistent hashing — here only a small version, enough to show the idea; full depth in Lesson 10.1.
// Every shard is placed at many points on a circle (ring) (virtual nodes); a key
// goes to the shard of the next point clockwise from it on the circle.
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
		`\nb. Going from 3 to 4 shards — how many of ${KEYS.toLocaleString('en-US')} workspaces must move to another shard?\n`
	);

	const movedModulo = keys.filter((k) => moduloShard(k, 3) !== moduloShard(k, 4)).length;
	const ring3 = buildRing(3);
	const ring4 = buildRing(4);
	const movedRing = keys.filter((k) => ringShard(ring3, k) !== ringShard(ring4, k)).length;
	const pct = (n: number): string => `${((n / KEYS) * 100).toFixed(1)}%`;

	console.log(
		`   hash % N              ${movedRing > 0 ? pct(movedModulo).padStart(6) : ''}   (${movedModulo.toLocaleString('en-US')})`
	);
	console.log(
		`   consistent hashing    ${pct(movedRing).padStart(6)}   (${movedRing.toLocaleString('en-US')})`
	);
	console.log(`   ideal (only the new shard's share = 1/4)   ${pct(KEYS / 4).padStart(6)}`);
}

function main(): void {
	writeDistribution(todaysWrites());
	resharding();
	console.log('');
}

main();
