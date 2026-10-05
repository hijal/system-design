// Lesson 6.5 — a small consistency checker (in the spirit of Jepsen's Knossos, much simpler).
//
// History = a list of several processes' read/write operations, each with its start and end time.
// Every key is a register with initial value 0; every write value is unique for that key — so which write
// a read got its value from ("reads-from") is known for certain.
//
// One question, under different rules: "is there some sequence (total order) in which, taking all operations
// as happening one after another, every read gets the value of the write just before it — and does the sequence obey these rules?"

export type Op = {
	id: number;
	process: string;
	kind: 'write' | 'read';
	key: string;
	value: number;
	start: number;
	end: number;
};

export type History = Op[];

let nextId = 0;
export function w(process: string, key: string, value: number, start: number, end: number): Op {
	return { id: nextId++, process, kind: 'write', key, value, start, end };
}
export function r(process: string, key: string, value: number, start: number, end: number): Op {
	return { id: nextId++, process, kind: 'read', key, value, start, end };
}

// find an order of ops that obeys mustPrecede and in which every read gets the right value.
// Backtracking + memo (which ops are done, and the current values of the registers).
function orderExists(ops: Op[], mustPrecede: (a: Op, b: Op) => boolean): boolean {
	const n = ops.length;
	if (n > 30) throw new Error('history too big — this checker handles up to 30 ops');
	const pred = ops.map((b) =>
		ops.reduce((mask, a, i) => (a !== b && mustPrecede(a, b) ? mask | (1 << i) : mask), 0)
	);
	const full = n === 30 ? 0x3fffffff : (1 << n) - 1;
	const seen = new Set<string>();

	function dfs(done: number, state: Map<string, number>): boolean {
		if (done === full) return true;
		const memo = `${done}|${[...state.entries()].sort().join(';')}`;
		if (seen.has(memo)) return false;
		seen.add(memo);
		for (let i = 0; i < n; i++) {
			if (done & (1 << i)) continue;
			if ((pred[i] ?? 0) & ~done) continue; // something that must come first has not come yet
			const op = ops[i];
			if (!op) continue;
			if (op.kind === 'read') {
				if ((state.get(op.key) ?? 0) !== op.value) continue; // this read could not get this value at this point
				if (dfs(done | (1 << i), state)) return true;
			} else {
				const next = new Map(state);
				next.set(op.key, op.value);
				if (dfs(done | (1 << i), next)) return true;
			}
		}
		return false;
	}
	return dfs(0, new Map());
}

// Linearizable: if one op ends before another starts (in any process), it is also earlier in the sequence.
export function linearizable(h: History): boolean {
	return orderExists(h, (a, b) => a.end < b.start);
}

// Sequential: only each process's own order must be kept; real time (across processes) need not be.
export function sequential(h: History): boolean {
	return orderExists(h, (a, b) => a.process === b.process && a.end <= b.start);
}

// Happens-before (Lesson 6.4): each process's own order + reads-from (write → the read that got its value), transitive.
export function happensBefore(h: History): (a: Op, b: Op) => boolean {
	const n = h.length;
	const index = new Map(h.map((op, i) => [op.id, i]));
	const reach: boolean[][] = h.map(() => new Array<boolean>(n).fill(false));
	h.forEach((a, i) =>
		h.forEach((b, j) => {
			const programOrder = a.process === b.process && a.end <= b.start && a !== b;
			const readsFrom =
				a.kind === 'write' && b.kind === 'read' && a.key === b.key && a.value === b.value;
			const row = reach[i];
			if (row && (programOrder || readsFrom)) row[j] = true;
		})
	);
	for (let k = 0; k < n; k++)
		for (let i = 0; i < n; i++)
			if (reach[i]?.[k])
				for (let j = 0; j < n; j++) if (reach[k]?.[j]) (reach[i] as boolean[])[j] = true;
	return (a, b) => reach[index.get(a.id) ?? -1]?.[index.get(b.id) ?? -1] ?? false;
}

// Causal: separately for each process — all writes plus that process's own reads can be put in an order
// that obeys happens-before. (Different processes may see concurrent writes in different orders.)
export function causal(h: History): boolean {
	const hb = happensBefore(h);
	if (h.some((op) => hb(op, op))) return false; // a cycle — the causality itself is impossible
	const processes = [...new Set(h.map((op) => op.process))];
	return processes.every((p) =>
		orderExists(
			h.filter((op) => op.kind === 'write' || op.process === p),
			hb
		)
	);
}

function source(h: History, read: Op): Op | null {
	return (
		h.find((op) => op.kind === 'write' && op.key === read.key && op.value === read.value) ?? null
	);
}

// Read-your-writes: a process's own read after its own write — not the initial value or a value older than its write
export function readYourWrites(h: History): boolean {
	const hb = happensBefore(h);
	return h.every((mine) => {
		if (mine.kind !== 'write') return true;
		return h.every((read) => {
			if (
				read.kind !== 'read' ||
				read.process !== mine.process ||
				read.key !== mine.key ||
				read.start < mine.end
			)
				return true;
			const s = source(h, read);
			return s !== null && (s === mine || !hb(s, mine));
		});
	});
}

// Monotonic reads: of two successive reads by the same process, the second is not older than the first
export function monotonicReads(h: History): boolean {
	const hb = happensBefore(h);
	return h.every((first) =>
		h.every((second) => {
			if (first.kind !== 'read' || second.kind !== 'read') return true;
			if (first.process !== second.process || first.key !== second.key || second.start < first.end)
				return true;
			const a = source(h, first);
			const b = source(h, second);
			if (a === null) return true; // the first is the initial value — nothing is older than that
			if (b === null) return false; // the initial value again after seeing a newer one
			return b === a || !hb(b, a);
		})
	);
}

// Eventual (bounded form): do all reads that start after writes stop (settleMs later) get the same value?
// With no such read there is no answer (null) — eventual consistency promises no bounded time.
export function eventual(h: History, settleMs = 200): boolean | null {
	const lastWrite = Math.max(0, ...h.filter((op) => op.kind === 'write').map((op) => op.end));
	const late = h.filter((op) => op.kind === 'read' && op.start > lastWrite + settleMs);
	if (late.length === 0) return null;
	const keys = [...new Set(late.map((op) => op.key))];
	return keys.every(
		(k) => new Set(late.filter((op) => op.key === k).map((op) => op.value)).size === 1
	);
}

export const MODELS = [
	['linearizable', linearizable],
	['sequential', sequential],
	['causal', causal],
	['read-your-writes', readYourWrites],
	['monotonic reads', monotonicReads]
] as const;
