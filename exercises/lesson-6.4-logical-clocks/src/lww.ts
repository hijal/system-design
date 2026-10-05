import { mulberry32 } from './random';

// Lesson 6.4 §1.3, 1.5–1.6 — the title of one task, three replicas, three kinds of "which one wins" rule.
//
// TaskFlow's multi-leader setup (Lesson 5.7): three replicas, each takes writes, then sends them
// to the others (10–50 ms later). n3's NTP is broken — its clock is 400 ms behind. n2 is 30 ms ahead.
//
// 6 people (thinking 3 s on average, 15 s between two edits on average) and 2 bots (like "when the status changes, put
// [DONE] in the title" — reacting in 50–300 ms) edit the same title for 2 minutes: read from one replica, think a little, then
// write to a (maybe different) replica. Every write knows which versions it saw when it was written — that is the real
// causality (ground truth), which we use to measure what each rule got wrong.
//
//   wall     — last-write-wins, by the replica clock's timestamp (like Cassandra's default)
//   lamport  — last-write-wins, by a Lamport clock
//   vector   — dotted version vector: with causality drop the older one, without it keep both (siblings)
//              and the next reader sees both and writes a merge

const NODES = ['n1', 'n2', 'n3'] as const;
type NodeId = (typeof NODES)[number];
const SKEW_MS: Record<NodeId, number> = { n1: 0, n2: 30, n3: -400 };
const SIM_MS = 120_000;
const HUMANS = 6;
const BOTS = 2;

type Strategy = 'wall' | 'lamport' | 'vector';
type Clock = Record<NodeId, number>;

// the real history of a write — no rule sees this, only we do, for measuring
type Write = { id: number; ancestors: Set<number> };

// a version kept on a replica
type Version = {
	writeId: number;
	wall: number;
	lamport: number;
	node: NodeId;
	dot: [NodeId, number]; // this write's own identity: which replica's write number how many
	ctx: Clock; // what the client had seen when writing (vector clock)
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
	// whether b is in a's history — b's dot falls within the context a saw
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

	// LWW dropped a version — classify it by real causality
	function discarded(loser: Version, winner: Version): void {
		if (ancestorsOf(winner.writeId).has(loser.writeId)) return; // fine: the winner came later, written after seeing the loser
		const key = `${loser.writeId}<${winner.writeId}`;
		if (ancestorsOf(loser.writeId).has(winner.writeId)) causalLoss.add(key);
		else concurrentDrop.add(key);
	}

	function apply(node: NodeId, v: Version): void {
		const current = state[node];
		if (strategy === 'vector') {
			if (current.some((s) => covers(s, v))) return; // already there, or older
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
		const newWins = a > b || (a === b && an > bn); // ties broken by the node's name
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
			wall: q.now + SKEW_MS[node], // the replica's own clock
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
			if (seen.length > 1) siblingReads++; // the app was shown two values and asked to merge them
			const think = bot ? 50 + random() * 250 : -3000 * Math.log(1 - random());
			const target = pick();
			q.add(q.now + think, () => {
				write(target, seen);
				q.add(q.now - (bot ? 2000 : 15_000) * Math.log(1 - random()), loop);
			});
		};
		q.add(random() * 2000, loop);
	}

	q.add(0, () => write('n1', [])); // the initial title
	for (let i = 0; i < HUMANS; i++) client(false);
	for (let i = 0; i < BOTS; i++) client(true);
	q.run();

	// all replication done — which writes left no trace (neither surviving, nor in a surviving write's history)?
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
		`\n   3 replicas (n3's clock 400 ms behind, n2 30 ms ahead), ${HUMANS} people + ${BOTS} bots, ${SIM_MS / 1000} s`
	);
	console.log(
		'   everyone edits the title of the same task (seeded — the same result every time)\n'
	);
	console.log(
		'   rule                   total edits   later edit lost to   concurrent edit   app asked to   not in final     replicas'
	);
	console.log(
		'                                       the earlier one       silently dropped  merge           title history    agree?'
	);
	const labels: Record<Strategy, string> = {
		wall: 'LWW — wall clock',
		lamport: 'LWW — Lamport clock',
		vector: 'Vector clock (sibling)'
	};
	for (const strategy of ['wall', 'lamport', 'vector'] as const) {
		const r = run(strategy);
		console.log(
			`   ${labels[strategy].padEnd(22)} ${String(r.writes).padStart(6)}   ${String(r.causalLoss).padStart(14)}       ${String(r.concurrentDrop).padStart(14)}    ${String(r.siblingReads).padStart(12)}    ${String(r.lost).padStart(14)}       ${r.converged ? 'yes' : 'no'}`
		);
	}
	console.log('');
}

main();
