// Lesson 6.4 §1.4–1.6 — Lamport clocks and vector clocks, in a small example you can check by hand.
//
// Three processes: A (Rahim's laptop), B (the TaskFlow server), C (Karim's phone). Every event is local
// (its own work), send (sending a message), or receive (getting a message). Following the rules, the program
// computes the Lamport timestamp and vector timestamp of every event, then compares a few pairs.
//
// Work it out on paper yourself first, then run it and compare.

type Proc = 'A' | 'B' | 'C';
const PROCS: Proc[] = ['A', 'B', 'C'];
type Vector = Record<Proc, number>;

type Step =
	| { kind: 'local'; proc: Proc; name: string; note: string }
	| { kind: 'send'; proc: Proc; name: string; note: string; message: string }
	| { kind: 'receive'; proc: Proc; name: string; note: string; message: string };

// a valid order — every receive after its send
const STEPS: Step[] = [
	{ kind: 'local', proc: 'A', name: 'a1', note: 'Rahim wrote the title' },
	{ kind: 'local', proc: 'C', name: 'c1', note: 'Karim wrote a comment offline' },
	{ kind: 'send', proc: 'A', name: 'a2', note: 'sent the title to the server', message: 'm1' },
	{ kind: 'receive', proc: 'B', name: 'b1', note: 'the server got the title', message: 'm1' },
	{ kind: 'local', proc: 'A', name: 'a3', note: 'Rahim changed the description' },
	{ kind: 'send', proc: 'B', name: 'b2', note: 'the server notified Karim', message: 'm2' },
	{ kind: 'local', proc: 'B', name: 'b3', note: 'the server wrote an audit log' },
	{ kind: 'receive', proc: 'C', name: 'c2', note: 'Karim got the notification', message: 'm2' },
	{ kind: 'send', proc: 'C', name: 'c3', note: 'Karim replied to Rahim', message: 'm3' },
	{ kind: 'receive', proc: 'A', name: 'a4', note: 'Rahim got the reply', message: 'm3' }
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

	console.log('\n   event process  kind      Lamport   vector [A,B,C]   what happened');
	for (const step of STEPS) {
		const p = step.proc;
		if (step.kind === 'receive') {
			// rule: merge with the received message's timestamp — max for Lamport, max in every slot for vector
			const got = inFlight.get(step.message);
			if (!got) throw new Error(`${step.message} cannot be received before it is sent`);
			lamport[p] = Math.max(lamport[p], got.lamport);
			for (const q of PROCS) vector[p][q] = Math.max(vector[p][q], got.vector[q]);
		}
		// rule: on every event, increment your own slot
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
			x.lamport < y.lamport ? `${a} < ${b}` : x.lamport > y.lamport ? `${a} > ${b}` : 'equal';
		const byVector =
			leq(x.vector, y.vector) && !leq(y.vector, x.vector)
				? `${a} → ${b} (happened before)`
				: leq(y.vector, x.vector) && !leq(x.vector, y.vector)
					? `${b} → ${a} (happened before)`
					: 'concurrent — neither knew about the other';
		return { byLamport, byVector };
	}

	console.log('\n   pair       Lamport says      vector clock says');
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
		'\n   A smaller Lamport number does not mean "happened before" — only the reverse is true. Recognising concurrency needs vectors.\n'
	);
}

main();
