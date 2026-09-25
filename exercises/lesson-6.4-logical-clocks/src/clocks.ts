// Lesson 6.4 §১.৪–১.৬ — Lamport clock আর vector clock, হাতে মেলানোর মতো ছোট একটা উদাহরণ।
//
// তিনটা process: A (রহিমের laptop), B (TaskFlow server), C (করিমের phone)। প্রতিটা ঘটনা হয় local
// (নিজের কাজ), send (message পাঠানো), বা receive (message পাওয়া)। Program নিয়ম মেনে প্রতিটা ঘটনার
// Lamport timestamp আর vector timestamp হিসাব করে, তারপর কয়েকটা জোড়া তুলনা করে।
//
// প্রথমে নিজে কাগজে হিসাব করো, তারপর চালিয়ে মেলাও।

type Proc = 'A' | 'B' | 'C';
const PROCS: Proc[] = ['A', 'B', 'C'];
type Vector = Record<Proc, number>;

type Step =
	| { kind: 'local'; proc: Proc; name: string; note: string }
	| { kind: 'send'; proc: Proc; name: string; note: string; message: string }
	| { kind: 'receive'; proc: Proc; name: string; note: string; message: string };

// একটা বৈধ ক্রম — প্রতিটা receive তার send এর পরে
const STEPS: Step[] = [
	{ kind: 'local', proc: 'A', name: 'a1', note: 'রহিম title লিখল' },
	{ kind: 'local', proc: 'C', name: 'c1', note: 'করিম offline এ একটা comment লিখল' },
	{ kind: 'send', proc: 'A', name: 'a2', note: 'title server এ পাঠাল', message: 'm1' },
	{ kind: 'receive', proc: 'B', name: 'b1', note: 'server title পেল', message: 'm1' },
	{ kind: 'local', proc: 'A', name: 'a3', note: 'রহিম description বদলাল' },
	{ kind: 'send', proc: 'B', name: 'b2', note: 'server করিমকে notify করল', message: 'm2' },
	{ kind: 'local', proc: 'B', name: 'b3', note: 'server audit log লিখল' },
	{ kind: 'receive', proc: 'C', name: 'c2', note: 'করিম notification পেল', message: 'm2' },
	{ kind: 'send', proc: 'C', name: 'c3', note: 'করিম উত্তর দিল রহিমকে', message: 'm3' },
	{ kind: 'receive', proc: 'A', name: 'a4', note: 'রহিম উত্তর পেল', message: 'm3' }
];

type Stamp = { lamport: number; vector: Vector };

function main(): void {
	const lamport: Record<Proc, number> = { A: 0, B: 0, C: 0 };
	const vector: Record<Proc, Vector> = {
		A: { A: 0, B: 0, C: 0 },
		B: { A: 0, B: 0, C: 0 },
		C: { A: 0, B: 0, C: 0 }
	};
	const inFlight = new Map<string, Stamp>();
	const stamps = new Map<string, Stamp>();

	console.log('\n   ঘটনা  process  ধরন       Lamport   vector [A,B,C]   কী হলো');
	for (const step of STEPS) {
		const p = step.proc;
		if (step.kind === 'receive') {
			// নিয়ম: পাওয়া message এর timestamp এর সাথে মিলিয়ে নাও — Lamport এ max, vector এ প্রতিটা ঘরে max
			const got = inFlight.get(step.message);
			if (!got) throw new Error(`${step.message} পাঠানোর আগে পাওয়া যায় না`);
			lamport[p] = Math.max(lamport[p], got.lamport);
			for (const q of PROCS) vector[p][q] = Math.max(vector[p][q], got.vector[q]);
		}
		// নিয়ম: প্রতিটা ঘটনায় নিজের ঘর এক বাড়াও
		lamport[p] += 1;
		vector[p][p] += 1;
		const stamp: Stamp = { lamport: lamport[p], vector: { ...vector[p] } };
		stamps.set(step.name, stamp);
		if (step.kind === 'send') inFlight.set(step.message, stamp);
		const kind =
			step.kind === 'local'
				? 'local'
				: step.kind === 'send'
					? `send ${step.message}`
					: `recv ${step.message}`;
		const v = `[${PROCS.map((q) => stamp.vector[q]).join(',')}]`;
		console.log(
			`   ${step.name.padEnd(5)} ${p.padEnd(8)} ${kind.padEnd(9)} ${String(stamp.lamport).padStart(4)}      ${v.padEnd(15)}  ${step.note}`
		);
	}

	const leq = (x: Vector, y: Vector): boolean => PROCS.every((q) => x[q] <= y[q]);
	function relation(a: string, b: string): { byLamport: string; byVector: string } {
		const x = stamps.get(a);
		const y = stamps.get(b);
		if (!x || !y) throw new Error('unknown event');
		const byLamport =
			x.lamport < y.lamport ? `${a} < ${b}` : x.lamport > y.lamport ? `${a} > ${b}` : 'সমান';
		const byVector =
			leq(x.vector, y.vector) && !leq(y.vector, x.vector)
				? `${a} → ${b} (আগে ঘটেছে)`
				: leq(y.vector, x.vector) && !leq(x.vector, y.vector)
					? `${b} → ${a} (আগে ঘটেছে)`
					: 'concurrent — কেউ কারো কথা জানত না';
		return { byLamport, byVector };
	}

	console.log('\n   জোড়া       Lamport বলে       Vector clock বলে');
	for (const [a, b] of [
		['a1', 'a4'],
		['a2', 'c2'],
		['c1', 'a2'],
		['a3', 'b3'],
		['a3', 'c3']
	] as const) {
		const r = relation(a, b);
		console.log(`   ${`${a}, ${b}`.padEnd(10)}  ${r.byLamport.padEnd(15)}   ${r.byVector}`);
	}
	console.log(
		'\n   Lamport এর ছোট সংখ্যা মানে "আগে ঘটেছে" না — শুধু উল্টোটা সত্যি। Concurrent চিনতে vector লাগে।\n'
	);
}

main();
