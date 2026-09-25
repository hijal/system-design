import { latency, mulberry32, percentile } from './random';

// Lesson 5.9 §১.৫ — leaderless replication এর quorum, একটা ছোট simulation এ।
//
// N = 3 টা replica। একটা key এর পুরনো মান (v0) তিনটাতেই আছে।
//   ১. Client নতুন মান (v1) লেখে: coordinator তিনটা replica কেই পাঠায়, W টা ack পেলেই
//      client কে "সফল" বলে। (বাকিরাও পরে পায় — শুধু অপেক্ষা করা হয় না।)
//   ২. "সফল" পাওয়ার পরে client (বা অন্য কেউ) একই key পড়ে: coordinator তিনটাকেই জিজ্ঞেস
//      করে, প্রথম R টা উত্তর নেয়, আর তাদের মধ্যে সবচেয়ে নতুন version ফেরত দেয়।
//   ৩. ফেরত মান v0 হলে — **stale read**: সফল হওয়া লেখা পড়ায় দেখা গেল না।
//
// প্রতিটা replica এর network আলাদা: দুটো কাছে, একটা অন্য data center এ (ধীর)।
// আর বাস্তবের মতো, যেকোনো replica মাঝে মাঝে হঠাৎ পিছিয়ে পড়ে (GC pause, disk stall,
// overload) — প্রতিটা লেখায় ৫% সম্ভাবনায় সেই replica ৫০ ms দেরিতে প্রয়োগ করে।

const N = 3;
const TRIALS = 100_000;
const STALL_PROBABILITY = 0.05;
const STALL_MS = 50;
// replica প্রতি এক দিকের যাত্রা: ন্যূনতম ms + গড় বাড়তি ms
const LINKS: [number, number][] = [
	[0.5, 1], // replica A — একই data center
	[0.5, 1.5], // replica B — একই data center
	[10, 10] // replica C — অন্য data center
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
	const random = mulberry32(2026); // প্রতিটা (W, R) একই random ক্রম পায় — ন্যায্য তুলনা
	const oneWay = (i: number): number => latency(random, ...link(i));
	let stale = 0;
	const writeTimes: number[] = [];
	const readTimes: number[] = [];

	for (let trial = 0; trial < TRIALS; trial++) {
		// ── লেখা (সময় ০ থেকে শুরু) ──
		const appliedAt: number[] = []; // replica i কখন v1 প্রয়োগ করল
		const ackAt: number[] = []; // coordinator কখন replica i এর ack পেল
		for (let i = 0; i < N; i++) {
			const stall = random() < STALL_PROBABILITY ? STALL_MS : 0;
			appliedAt[i] = oneWay(i) + stall;
			ackAt[i] = (appliedAt[i] ?? 0) + oneWay(i);
		}
		const writeDone = [...ackAt].sort((a, b) => a - b)[W - 1] ?? 0; // W তম ack
		writeTimes.push(writeDone);

		// ── পড়া (লেখা সফল হওয়ার gapMs পরে শুরু) ──
		const readStart = writeDone + gapMs;
		const responses: { at: number; version: number }[] = [];
		for (let i = 0; i < N; i++) {
			const arrives = readStart + oneWay(i); // request replica তে পৌঁছাল
			const version = (appliedAt[i] ?? Infinity) <= arrives ? 1 : 0; // তখন কোন মান আছে
			responses.push({ at: arrives + oneWay(i), version });
		}
		responses.sort((a, b) => a.at - b.at);
		const firstR = responses.slice(0, R); // প্রথম R টা উত্তর
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
	console.log('   W  R  W+R>N?   stale read              লেখা p50 / p99       পড়া p50 / p99');
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
			`   ${W}  ${R}  ${W + R > N ? 'হ্যাঁ ' : 'না   '}   ${String(r.stale).padStart(6)}/${TRIALS} (${pct.padStart(5)}%)   ${fmt(r.writeP50, r.writeP99)}   ${fmt(r.readP50, r.readP99)}`
		);
	}
}

function availabilityTable(): void {
	console.log(`\n৩. কয়টা replica মরলে কী চলে? (N = ${N})`);
	console.log('   W  R   │ ০টা মৃত      │ ১টা মৃত      │ ২টা মৃত');
	const combos: [number, number][] = [
		[1, 1],
		[2, 2],
		[3, 1],
		[1, 3]
	];
	for (const [W, R] of combos) {
		const cells = [0, 1, 2].map((down) => {
			const up = N - down;
			return `${up >= W ? 'লেখা ✓' : 'লেখা ✗'} ${up >= R ? 'পড়া ✓' : 'পড়া ✗'}`;
		});
		console.log(`   ${W}  ${R}   │ ${cells.join(' │ ')}`);
	}
}

function main(): void {
	console.log(`\n   N = ${N} replica: A, B একই data center এ; C অন্য data center এ (ধীর)`);
	console.log(
		`   প্রতিটা জোড়ায় ${TRIALS.toLocaleString('en-US')} বার "লেখো, তারপর পড়ো" (seed দেওয়া — প্রতিবার একই ফল)`
	);
	quorumTable(0, '১. লেখা সফল হওয়ার ঠিক পরেই পড়া (একই user, read-your-writes)');
	quorumTable(5, '২. লেখা সফল হওয়ার ৫ ms পরে পড়া (অন্য একজন user)');
	availabilityTable();
	console.log('');
}

main();
