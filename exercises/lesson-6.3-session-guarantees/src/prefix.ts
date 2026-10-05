import { mulberry32 } from './random';
import { Replica, type LagModel } from './replica';

// Lesson 6.3 §1.5 — Consistent prefix: the answer first, the question later.
//
// TaskFlow's comment table is split into two partitions (Lesson 5.8), each with its own primary and replica.
// Rahim asks a question on a task ("when is the deploy?"), and a little later Karim answers ("9 pm tonight").
// Others read the thread — from the two partitions' replicas.
//
// Comparing two shard keys:
//   commentId  → the question and the answer are often in two different partitions
//   taskId     → all of a task's comments are in the same partition
//
// Answer timing: 30% of answers are from an automation (+50 ms, like "bot: PR linked"), the rest from people (1–10 s).

const SIM_MS = 120_000;
const WRITES_PER_S_PER_PARTITION = 200;
const THREADS = 5000;
const READS_PER_THREAD = 20;
const LAG: LagModel = { base: 5, mean: 20, stallPerWrite: 0.0002, stallMs: 3000 };

type ShardKey = 'commentId' | 'taskId';
type Write = {
	at: number;
	partition: number;
	thread: number;
	kind: 'question' | 'answer' | 'other';
};

function workload(shardKey: ShardKey): {
	writes: Write[];
	reads: { at: number; thread: number }[];
} {
	const random = mulberry32(66);
	const writes: Write[] = [];
	for (let p = 0; p < 2; p++)
		for (let t = 0; t < SIM_MS;) {
			t += -Math.log(1 - random()) * (1000 / WRITES_PER_S_PER_PARTITION);
			writes.push({ at: t, partition: p, thread: -1, kind: 'other' });
		}
	const reads: { at: number; thread: number }[] = [];
	for (let thread = 0; thread < THREADS; thread++) {
		const asked = 1000 + random() * (SIM_MS - 15_000);
		const gap = random() < 0.3 ? 50 : 1000 + random() * 9000;
		// partition by the hash of commentId: the question and answer go either way independently. taskId: both go the same way.
		const qPartition = Math.floor(random() * 2);
		const aPartition = shardKey === 'taskId' ? qPartition : Math.floor(random() * 2);
		writes.push({ at: asked, partition: qPartition, thread, kind: 'question' });
		writes.push({ at: asked + gap, partition: aPartition, thread, kind: 'answer' });
		for (let i = 0; i < READS_PER_THREAD; i++)
			reads.push({ at: asked + random() * 12_000, thread });
	}
	writes.sort((a, b) => a.at - b.at);
	reads.sort((a, b) => a.at - b.at);
	return { writes, reads };
}

function run(shardKey: ShardKey): { sawAnswer: number; answerWithoutQuestion: number } {
	const { writes, reads } = workload(shardKey);
	const lagRandom = mulberry32(67);
	const replicas = [new Replica(LAG, lagRandom), new Replica(LAG, lagRandom)];
	const lsn = [0, 0];
	// thread → which LSN of which partition the question and answer are at
	const where = new Map<number, { q?: [number, number]; a?: [number, number] }>();
	for (const w of writes) {
		lsn[w.partition] = (lsn[w.partition] ?? 0) + 1;
		replicas[w.partition]?.receive(w.at);
		if (w.kind === 'other') continue;
		const entry = where.get(w.thread) ?? {};
		const pos: [number, number] = [w.partition, lsn[w.partition] ?? 0];
		if (w.kind === 'question') entry.q = pos;
		else entry.a = pos;
		where.set(w.thread, entry);
	}
	let sawAnswer = 0;
	let answerWithoutQuestion = 0;
	for (const read of reads) {
		const entry = where.get(read.thread);
		if (!entry?.q || !entry.a) continue;
		// the reader reads from both partitions' replicas at the same moment
		const visible = ([p, l]: [number, number]): boolean =>
			(replicas[p]?.replayedAt(read.at) ?? 0) >= l;
		const q = visible(entry.q);
		const a = visible(entry.a);
		if (a) sawAnswer++;
		if (a && !q) answerWithoutQuestion++;
	}
	return { sawAnswer, answerWithoutQuestion };
}

function main(): void {
	console.log(
		`\n   comments in 2 partitions, each with one async replica; ${THREADS} question-answer pairs, each thread read ${READS_PER_THREAD} times`
	);
	console.log('   (seeded — the same result every time)\n');
	console.log('   shard key       answer seen         answer present but question missing');
	for (const key of ['commentId', 'taskId'] as const) {
		const r = run(key);
		console.log(
			`   ${key.padEnd(12)}    ${String(r.sawAnswer).padStart(10)}          ${String(r.answerWithoutQuestion).padStart(6)}`
		);
	}
	console.log('');
}

main();
