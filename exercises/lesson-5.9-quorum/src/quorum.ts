import { latency, mulberry32, percentile } from './random';

// Lesson 5.9 §1.5 - quorum in leaderless replication, as a small simulation.
//
// N = 3 replicas. The old value of a key (v0) is on all three.
//   1. The client writes a new value (v1): the coordinator sends it to all three replicas, and as soon as
//      it gets W acks it tells the client "success". (The rest get it later too - it just doesn't wait.)
//   2. After getting "success", the client (or someone else) reads the same key: the coordinator asks
//      all three, takes the first R answers, and returns the newest version among them.
//   3. If the value returned is v0 - a **stale read**: a successful write was not seen by the read.
//
// Each replica has its own network: two close by, one in another data center (slow).
// And as in reality, any replica occasionally falls behind suddenly (GC pause, disk stall,
// overload) - on each write, with 5% probability, that replica applies it 50 ms late.

const N = 3;
const TRIALS = 100_000;
const STALL_PROBABILITY = 0.05;
const STALL_MS = 50;
// one-way trip per replica: minimum ms + average extra ms
const LINKS: [number, number][] = [
	[0.5, 1], // replica A - same data center
	[0.5, 1.5], // replica B - same data center
	[10, 10] // replica C - another data center
];

type Result = {
	stale: number;
	writeP50: number;
	writeP99: number;
	readP50: number;
	readP99: number;
};

function link(i: number): [number, number] {
	const l = LINKS[i];
	if (!l) throw new Error(`no link ${i}`);
	return l;
}

function simulate(W: number, R: number, gapMs: number): Result {
	const random = mulberry32(2026); // every (W, R) gets the same random sequence - a fair comparison
	const oneWay = (i: number): number => latency(random, ...link(i));
	let stale = 0;
	const writeTimes: number[] = [];
	const readTimes: number[] = [];

	for (let trial = 0; trial < TRIALS; trial++) {
		// ── write (starts at time 0) ──
		const appliedAt: number[] = []; // when replica i applied v1
		const ackAt: number[] = []; // when the coordinator got replica i's ack
		for (let i = 0; i < N; i++) {
			const stall = random() < STALL_PROBABILITY ? STALL_MS : 0;
			appliedAt[i] = oneWay(i) + stall;
			ackAt[i] = (appliedAt[i] ?? 0) + oneWay(i);
		}
		const writeDone = [...ackAt].sort((a, b) => a - b)[W - 1] ?? 0; // the W-th ack
		writeTimes.push(writeDone);

		// ── read (starts gapMs after the write succeeded) ──
		const readStart = writeDone + gapMs;
		const responses: { at: number; version: number }[] = [];
		for (let i = 0; i < N; i++) {
			const arrives = readStart + oneWay(i); // the request reached the replica
			const version = (appliedAt[i] ?? Infinity) <= arrives ? 1 : 0; // which value it has then
			responses.push({ at: arrives + oneWay(i), version });
		}
		responses.sort((a, b) => a.at - b.at);
		const firstR = responses.slice(0, R); // the first R answers
		const newest = Math.max(...firstR.map((r) => r.version));
		readTimes.push((firstR[R - 1]?.at ?? readStart) - readStart);
		if (newest === 0) stale++;
	}

	return {
		stale,
		writeP50: percentile(writeTimes, 50),
		writeP99: percentile(writeTimes, 99),
		readP50: percentile(readTimes, 50),
		readP99: percentile(readTimes, 99)
	};
}

function quorumTable(gapMs: number, label: string): void {
	console.log(`\n${label}`);
	console.log('   W  R  W+R>N?   stale read              write p50 / p99      read p50 / p99');
	const combos: [number, number][] = [
		[1, 1],
		[1, 2],
		[2, 1],
		[2, 2],
		[3, 1],
		[1, 3]
	];
	for (const [W, R] of combos) {
		const r = simulate(W, R, gapMs);
		const pct = ((r.stale / TRIALS) * 100).toFixed(2);
		const fmt = (a: number, b: number): string =>
			`${a.toFixed(1).padStart(5)} / ${b.toFixed(1).padStart(5)} ms`;
		console.log(
			`   ${W}  ${R}  ${W + R > N ? 'yes  ' : 'no   '}   ${String(r.stale).padStart(6)}/${TRIALS} (${pct.padStart(5)}%)   ${fmt(r.writeP50, r.writeP99)}   ${fmt(r.readP50, r.readP99)}`
		);
	}
}

function availabilityTable(): void {
	console.log(`\n3. How many replicas can die and what still works? (N = ${N})`);
	console.log('   W  R   │ 0 dead         │ 1 dead         │ 2 dead');
	const combos: [number, number][] = [
		[1, 1],
		[2, 2],
		[3, 1],
		[1, 3]
	];
	for (const [W, R] of combos) {
		const cells = [0, 1, 2].map((down) => {
			const up = N - down;
			return `${up >= W ? 'write ✓' : 'write ✗'} ${up >= R ? 'read ✓' : 'read ✗'}`;
		});
		console.log(`   ${W}  ${R}   │ ${cells.join(' │ ')}`);
	}
}

function main(): void {
	console.log(
		`\n   N = ${N} replicas: A, B in the same data center; C in another data center (slow)`
	);
	console.log(
		`   ${TRIALS.toLocaleString('en-US')} times "write, then read" for each pair (seeded - the same result every time)`
	);
	quorumTable(0, '1. Read right after the write succeeds (same user, read-your-writes)');
	quorumTable(5, '2. Read 5 ms after the write succeeds (another user)');
	availabilityTable();
	console.log('');
}

main();
