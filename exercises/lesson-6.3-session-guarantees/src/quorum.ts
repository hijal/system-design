import { mulberry32 } from './random';

// Lesson 6.3 §1.6 — even with R + W > N, time can go backwards: the ghost of a "failed" write.
//
// A leaderless store (Lesson 5.9), N = 3 (A, B, C), W = 2, R = 2 — R + W > N on paper.
// One key of TaskFlow's notification counter has the value v0, on all three.
//
// A write v1 arrives. A gets it. B and C are busy at that moment — timeout. W = 2 is not met, so the client is told
// "write failed". But v1 is **not deleted** from A — a leaderless store has no rollback.
//
// Then 100 users each read 5 times (taking turns). Each read asks 2 random replicas
// and takes the newer version. Two ways:
//   read repair off — just read
//   read repair on  — during the read, write the new value to the replica that returned the old one

type Replica = 'A' | 'B' | 'C';
const REPLICAS: Replica[] = ['A', 'B', 'C'];
const USERS = 100;
const READS_EACH = 5;

function run(readRepair: boolean): {
	sawV1: number;
	wentBack: number;
	flipsPerUser: number[];
	finalState: string;
} {
	const random = mulberry32(68);
	const version = new Map<Replica, number>([
		['A', 1], // the "failed" write is only on A
		['B', 0],
		['C', 0]
	]);
	const lastSeen = new Array<number>(USERS).fill(-1);
	const flips = new Array<number>(USERS).fill(0);
	let sawV1 = 0;
	let wentBack = 0;

	for (let round = 0; round < READS_EACH; round++)
		for (let user = 0; user < USERS; user++) {
			const first = REPLICAS[Math.floor(random() * 3)] ?? 'A';
			const rest = REPLICAS.filter((r) => r !== first);
			const second = rest[Math.floor(random() * 2)] ?? 'B';
			const newest = Math.max(version.get(first) ?? 0, version.get(second) ?? 0);
			if (readRepair) for (const r of [first, second]) version.set(r, newest);
			if (newest === 1) sawV1++;
			const prev = lastSeen[user] ?? -1;
			if (newest < prev) wentBack++;
			if (prev !== -1 && newest !== prev) flips[user] = (flips[user] ?? 0) + 1;
			lastSeen[user] = newest;
		}
	const finalState = REPLICAS.map((r) => `${r}=v${version.get(r) ?? 0}`).join(' ');
	return { sawV1, wentBack, flipsPerUser: flips, finalState };
}

function main(): void {
	console.log(
		'\n   N = 3, W = 2, R = 2 (R + W > N). Write v1 reached only A → the client was told "failed".'
	);
	console.log(
		`   then ${USERS} users × ${READS_EACH} reads each (seeded — the same result every time)\n`
	);
	console.log(
		'   read repair    saw the "failed" v1      back to v0 after v1      users whose value flipped    final state'
	);
	for (const repair of [false, true]) {
		const r = run(repair);
		const total = USERS * READS_EACH;
		const flippers = r.flipsPerUser.filter((f) => f >= 2).length;
		console.log(
			`   ${(repair ? 'on' : 'off').padEnd(12)}   ${`${r.sawV1}/${total}`.padStart(9)}              ${String(r.wentBack).padStart(5)}                   ${String(flippers).padStart(5)}                ${r.finalState}`
		);
	}
	console.log('');
}

main();
