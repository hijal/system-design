// Lesson 6.5 — একটা ছোট consistency checker (Jepsen এর Knossos এর ধারণায়, অনেক সরল)।
//
// History = কয়েকটা process এর read/write operation এর তালিকা, প্রতিটার শুরু আর শেষের সময় সহ।
// প্রতিটা key একটা register, শুরুর মান 0; প্রতিটা write এর মান ওই key তে অনন্য — তাই একটা read
// কোন write এর মান পেয়েছে ("reads-from"), সেটা নিশ্চিতভাবে জানা যায়।
//
// প্রশ্ন একটাই, ভিন্ন ভিন্ন নিয়মে: "এমন কোনো একটা সারি (total order) আছে কি, যেখানে সব operation
// একটার পর একটা ঘটেছে বলে ধরলে প্রতিটা read ঠিক আগের write এর মান পায় — আর সারিটা এই নিয়মগুলো মানে?"

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

// ops এর এমন একটা ক্রম খোঁজো যেটা mustPrecede মানে আর যেখানে প্রতিটা read সঠিক মান পায়।
// Backtracking + memo (কোন op গুলো হয়ে গেছে, আর register গুলোর বর্তমান মান)।
function orderExists(ops: Op[], mustPrecede: (a: Op, b: Op) => boolean): boolean {
	const n = ops.length;
	if (n > 30) throw new Error('history খুব বড় — এই checker ৩০ টা op পর্যন্ত');
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
			if ((pred[i] ?? 0) & ~done) continue; // যাকে আগে আসতে হবে, সে এখনো আসেনি
			const op = ops[i];
			if (!op) continue;
			if (op.kind === 'read') {
				if ((state.get(op.key) ?? 0) !== op.value) continue; // এই মুহূর্তে এই read এই মান পেত না
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

// Linearizable: একটা op শেষ হওয়ার পরে আরেকটা শুরু হলে (যেকোনো process এর), সারিতেও সেটা পরে।
export function linearizable(h: History): boolean {
	return orderExists(h, (a, b) => a.end < b.start);
}

// Sequential: শুধু প্রতিটা process এর নিজের ক্রম মানতে হবে; আসল সময় (process পেরিয়ে) মানতে হয় না।
export function sequential(h: History): boolean {
	return orderExists(h, (a, b) => a.process === b.process && a.end <= b.start);
}

// Happens-before (Lesson 6.4): নিজের process এর ক্রম + reads-from (write → যে read তার মান পেল), transitive।
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

// Causal: প্রতিটা process এর জন্য আলাদা — সব write আর ওই process এর নিজের read গুলো এমন একটা ক্রমে
// সাজানো যায় যেটা happens-before মানে। (বিভিন্ন process concurrent write গুলো ভিন্ন ক্রমে দেখতে পারে।)
export function causal(h: History): boolean {
	const hb = happensBefore(h);
	if (h.some((op) => hb(op, op))) return false; // চক্র — কার্যকারণ নিজেই অসম্ভব
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

// Read-your-writes: নিজের write এর পরে নিজের read — শুরুর মান বা নিজের write এর আগের কোনো মান না
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

// Monotonic reads: একই process এর পরপর দুটো read এ দ্বিতীয়টা প্রথমটার চেয়ে পুরনো না
export function monotonicReads(h: History): boolean {
	const hb = happensBefore(h);
	return h.every((first) =>
		h.every((second) => {
			if (first.kind !== 'read' || second.kind !== 'read') return true;
			if (first.process !== second.process || first.key !== second.key || second.start < first.end)
				return true;
			const a = source(h, first);
			const b = source(h, second);
			if (a === null) return true; // প্রথমটা শুরুর মান — এর চেয়ে পুরনো কিছু নেই
			if (b === null) return false; // নতুন দেখার পরে আবার শুরুর মান
			return b === a || !hb(b, a);
		})
	);
}

// Eventual (সীমিত রূপ): সব write থেমে যাওয়ার পরে (settleMs পরে) শুরু হওয়া read গুলো সব একই মান পায় কিনা।
// সেরকম read না থাকলে উত্তর নেই (null) — eventual consistency কোনো সীমিত সময়ের কথা দেয় না।
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
