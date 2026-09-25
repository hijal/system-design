import { mulberry32 } from './random';

// Lesson 6.4 §১.৩, ১.৫–১.৬ — একই task এর title, তিনটা replica, তিন রকম "কোনটা জিতবে" নিয়ম।
//
// TaskFlow এর multi-leader setup (Lesson 5.7): তিনটা replica, প্রত্যেকে লেখা নেয়, তারপর বাকিদের
// পাঠায় (১০–৫০ ms পরে)। n3 এর NTP ভাঙা — তার ঘড়ি ৪০০ ms পিছিয়ে। n2 ৩০ ms এগিয়ে।
//
// ৬ জন মানুষ (ভাবতে গড়ে ৩ s, দুটো edit এর মাঝে গড়ে ১৫ s) আর ২টা bot (যেমন "status বদলালে title এ
// [DONE] লাগাও" — প্রতিক্রিয়া ৫০–৩০০ ms) ২ মিনিট ধরে একই title edit করে: একটা replica থেকে পড়ে, একটু ভাবে, তারপর
// (হয়তো অন্য) replica তে লেখে। প্রতিটা লেখা জানে সে কোন version গুলো দেখে লিখেছে — সেটাই সত্যিকারের
// কার্যকারণ (ground truth), যেটা দিয়ে মাপি কোন নিয়ম কী ভুল করল।
//
//   wall     — last-write-wins, replica এর ঘড়ির timestamp দিয়ে (Cassandra এর default এর মতো)
//   lamport  — last-write-wins, Lamport clock দিয়ে
//   vector   — dotted version vector: কার্যকারণ থাকলে পুরনোটা বাদ, না থাকলে দুটোই রাখো (sibling)
//              আর পরের পাঠক দুটো দেখে মিলিয়ে লেখে

const NODES = ['n1', 'n2', 'n3'] as const;
type NodeId = (typeof NODES)[number];
const SKEW_MS: Record<NodeId, number> = { n1: 0, n2: 30, n3: -400 };
const SIM_MS = 120_000;
const HUMANS = 6;
const BOTS = 2;

type Strategy = 'wall' | 'lamport' | 'vector';
type Clock = Record<NodeId, number>;

// একটা লেখার সত্যিকারের ইতিহাস — কোন নিয়মই এটা দেখে না, শুধু আমরা মাপার জন্য দেখি
type Write = { id: number; ancestors: Set<number> };

// Replica তে রাখা একটা version
type Version = {
	writeId: number;
	wall: number;
	lamport: number;
	node: NodeId;
	dot: [NodeId, number]; // এই লেখার নিজের পরিচয়: কোন replica র কত নম্বর লেখা
	ctx: Clock; // লেখার সময় client যা যা দেখেছিল (vector clock)
};

type Event = { at: number; seq: number; run: () => void };

class Queue {
	private items: Event[] = [];
	private seq = 0;
	now = 0;
	add(at: number, run: () => void): void {
		const item = { at, seq: this.seq++, run };
		let i = this.items.length;
		while (i > 0) {
			const prev = this.items[i - 1];
			if (prev === undefined || prev.at < at || (prev.at === at && prev.seq < item.seq)) break;
			i--;
		}
		this.items.splice(i, 0, item);
	}
	run(): void {
		for (let next = this.items.shift(); next; next = this.items.shift()) {
			this.now = next.at;
			next.run();
		}
	}
}

const emptyClock = (): Clock => ({ n1: 0, n2: 0, n3: 0 });

function covers(a: Version, b: Version): boolean {
	// a এর ইতিহাসে b আছে কিনা — b এর dot a এর দেখা context এর মধ্যে পড়ে
	return a.writeId === b.writeId || a.ctx[b.dot[0]] >= b.dot[1];
}

type Result = {
	writes: number;
	causalLoss: number;
	concurrentDrop: number;
	siblingReads: number;
	lost: number;
	converged: boolean;
};

function run(strategy: Strategy): Result {
	const random = mulberry32(64);
	const q = new Queue();
	const state: Record<NodeId, Version[]> = { n1: [], n2: [], n3: [] };
	const lamport: Clock = emptyClock();
	const counter: Clock = emptyClock();
	const writes: Write[] = [];
	const causalLoss = new Set<string>();
	const concurrentDrop = new Set<string>();
	let siblingReads = 0;

	const ancestorsOf = (id: number): Set<number> => writes[id]?.ancestors ?? new Set();

	// LWW এ একটা version বাদ পড়ল — সত্যিকারের কার্যকারণ দিয়ে শ্রেণিভাগ
	function discarded(loser: Version, winner: Version): void {
		if (ancestorsOf(winner.writeId).has(loser.writeId)) return; // ঠিক আছে: winner পরে, loser কে দেখে লেখা
		const key = `${loser.writeId}<${winner.writeId}`;
		if (ancestorsOf(loser.writeId).has(winner.writeId)) causalLoss.add(key);
		else concurrentDrop.add(key);
	}

	function apply(node: NodeId, v: Version): void {
		const current = state[node];
		if (strategy === 'vector') {
			if (current.some((s) => covers(s, v))) return; // ইতিমধ্যে আছে, বা পুরনো
			state[node] = [...current.filter((s) => !covers(v, s)), v];
			return;
		}
		lamport[node] = Math.max(lamport[node], v.lamport);
		const existing = current[0];
		if (!existing) {
			state[node] = [v];
			return;
		}
		if (existing.writeId === v.writeId) return;
		const key = (x: Version): [number, string] => [
			strategy === 'wall' ? x.wall : x.lamport,
			x.node
		];
		const [a, an] = key(v);
		const [b, bn] = key(existing);
		const newWins = a > b || (a === b && an > bn); // সমান হলে node এর নাম দিয়ে ভাঙা
		if (newWins) {
			discarded(existing, v);
			state[node] = [v];
		} else discarded(v, existing);
	}

	function write(node: NodeId, seen: Version[]): void {
		const id = writes.length;
		const ancestors = new Set<number>();
		for (const s of seen) {
			ancestors.add(s.writeId);
			for (const a of ancestorsOf(s.writeId)) ancestors.add(a);
		}
		writes.push({ id, ancestors });

		const ctx = emptyClock();
		for (const s of seen)
			for (const n of NODES) ctx[n] = Math.max(ctx[n], s.ctx[n], s.dot[0] === n ? s.dot[1] : 0);
		lamport[node] = Math.max(lamport[node], ...seen.map((s) => s.lamport)) + 1;
		counter[node] += 1;
		const v: Version = {
			writeId: id,
			wall: q.now + SKEW_MS[node], // replica এর নিজের ঘড়ি
			lamport: lamport[node],
			node,
			dot: [node, counter[node]],
			ctx
		};
		apply(node, v);
		for (const other of NODES)
			if (other !== node) q.add(q.now + 10 + random() * 40, () => apply(other, v));
	}

	function client(bot: boolean): void {
		const pick = (): NodeId => NODES[Math.floor(random() * NODES.length)] ?? 'n1';
		const loop = (): void => {
			if (q.now > SIM_MS) return;
			const seen = [...state[pick()]];
			if (seen.length > 1) siblingReads++; // app কে দুটো মান দেখিয়ে মেলাতে বলা হলো
			const think = bot ? 50 + random() * 250 : -3000 * Math.log(1 - random());
			const target = pick();
			q.add(q.now + think, () => {
				write(target, seen);
				q.add(q.now - (bot ? 2000 : 15_000) * Math.log(1 - random()), loop);
			});
		};
		q.add(random() * 2000, loop);
	}

	q.add(0, () => write('n1', [])); // শুরুর title
	for (let i = 0; i < HUMANS; i++) client(false);
	for (let i = 0; i < BOTS; i++) client(true);
	q.run();

	// সব replication শেষ — কোন লেখা গুলোর কোনো চিহ্ন নেই (না টিকে আছে, না কোনো টিকে থাকা লেখার ইতিহাসে)?
	const survivors = new Set<number>();
	for (const n of NODES) for (const v of state[n]) survivors.add(v.writeId);
	const remembered = new Set<number>(survivors);
	for (const s of survivors) for (const a of ancestorsOf(s)) remembered.add(a);
	const signature = (n: NodeId): string =>
		state[n]
			.map((v) => v.writeId)
			.sort((a, b) => a - b)
			.join(',');

	return {
		writes: writes.length,
		causalLoss: causalLoss.size,
		concurrentDrop: concurrentDrop.size,
		siblingReads,
		lost: writes.length - remembered.size,
		converged: NODES.every((n) => signature(n) === signature('n1'))
	};
}

function main(): void {
	console.log(
		`\n   ৩টা replica (n3 এর ঘড়ি ৪০০ ms পিছিয়ে, n2 ৩০ ms এগিয়ে), ${HUMANS} জন মানুষ + ${BOTS}টা bot, ${SIM_MS / 1000} s`
	);
	console.log('   সবাই একই task এর title edit করে (seed দেওয়া — প্রতিবার একই ফল)\n');
	console.log(
		'   নিয়ম                 মোট edit   পরে-করা edit আগেরটার    একসাথে-করা edit    app কে মেলাতে    শেষ title এর    replica'
	);
	console.log(
		'                                     কাছে হারল            নীরবে বাদ          বলা হলো         ইতিহাসে নেই       এক?'
	);
	const labels: Record<Strategy, string> = {
		wall: 'LWW — ঘড়ির সময়',
		lamport: 'LWW — Lamport clock',
		vector: 'Vector clock (sibling)'
	};
	for (const strategy of ['wall', 'lamport', 'vector'] as const) {
		const r = run(strategy);
		console.log(
			`   ${labels[strategy].padEnd(22)} ${String(r.writes).padStart(6)}   ${String(r.causalLoss).padStart(14)}       ${String(r.concurrentDrop).padStart(14)}    ${String(r.siblingReads).padStart(12)}    ${String(r.lost).padStart(14)}       ${r.converged ? 'হ্যাঁ' : 'না'}`
		);
	}
	console.log('');
}

main();
