import { eventual, MODELS, type History, type Op } from './checker';
import { latency, mulberry32 } from './random';

// Lesson 6.5 §1.7 — the idea of Jepsen, in small: run a system, record the history of every operation,
// then use a checker to verify which consistency model it actually provides.
//
// Four systems, 300 random histories each (3 clients, 5 operations each, one key):
//   primary  — every read and write on one primary
//   replica  — writes on the primary, reads on either of two async replicas (Lesson 5.7, 6.3)
//   sticky   — each client always reads from the same replica
//   token    — version token: never reads from a replica behind the newest version the client has seen/written;
//              goes to the primary instead (Lesson 6.3)
// Finally every client reads once more 1 second later — to check eventual.

type System = 'primary' | 'replica' | 'sticky' | 'token';
const HISTORIES = 300;
const CLIENTS = ['P1', 'P2', 'P3'];
const OPS_EACH = 5;

function generate(system: System, seed: number): History {
	const random = mulberry32(seed);
	type Planned = {
		process: string;
		kind: 'write' | 'read';
		start: number;
		end: number;
		at: number;
		value: number;
	};
	const planned: Planned[] = [];
	let nextValue = 1;
	for (const process of CLIENTS) {
		let t = random() * 10;
		for (let i = 0; i <= OPS_EACH; i++) {
			const last = i === OPS_EACH; // the last one is a read 1 s later
			if (last) t += 1000;
			const kind = !last && random() < 0.35 ? 'write' : 'read';
			const start = t;
			const end = t + 2 + random() * 8;
			// when the operation actually took effect — some moment between its start and end
			const at = start + random() * (end - start);
			planned.push({ process, kind, start, end, at, value: kind === 'write' ? nextValue++ : 0 });
			t = end + random() * 20;
		}
	}

	// Writes on the primary, in the order they took effect — this is the primary's log
	const log = planned.filter((p) => p.kind === 'write').sort((a, b) => a.at - b.at);
	// when each write becomes visible on each replica — a lag, sometimes large, and in order
	const visible = [0, 1].map(() => {
		let prev = 0;
		return log.map((wr) => {
			const lag = latency(random, 1, 5) + (random() < 0.05 ? 100 : 0);
			prev = Math.max(prev, wr.at + lag);
			return prev;
		});
	});
	const upTo = (times: number[], t: number): number => times.filter((x) => x <= t).length; // how many writes have been applied
	const valueAt = (count: number): number => log[count - 1]?.value ?? 0;
	const primaryCount = (t: number): number => log.filter((wr) => wr.at <= t).length;

	const token = new Map<string, number>();
	const ops: Op[] = [];
	let id = 0;
	for (const p of [...planned].sort((a, b) => a.start - b.start)) {
		if (p.kind === 'write') {
			ops.push({
				id: id++,
				process: p.process,
				kind: 'write',
				key: 'x',
				value: p.value,
				start: p.start,
				end: p.end
			});
			token.set(p.process, Math.max(token.get(p.process) ?? 0, log.indexOf(p) + 1));
			continue;
		}
		let count: number;
		const replica = system === 'sticky' ? CLIENTS.indexOf(p.process) % 2 : random() < 0.5 ? 0 : 1;
		const replicaCount = upTo(visible[replica] ?? [], p.at);
		if (system === 'primary') count = primaryCount(p.at);
		else if (system === 'token' && replicaCount < (token.get(p.process) ?? 0))
			count = primaryCount(p.at);
		else count = replicaCount;
		token.set(p.process, Math.max(token.get(p.process) ?? 0, count));
		ops.push({
			id: id++,
			process: p.process,
			kind: 'read',
			key: 'x',
			value: valueAt(count),
			start: p.start,
			end: p.end
		});
	}
	return ops;
}

function main(): void {
	const labels: Record<System, string> = {
		primary: 'one primary',
		replica: 'any replica',
		sticky: 'one replica per client',
		token: 'version token'
	};
	console.log(
		`\n   ${HISTORIES} random histories per system (${CLIENTS.length} clients × ${OPS_EACH + 1} ops) — what percentage obeys each model`
	);
	console.log('   (seeded — the same result every time)\n');
	console.log(
		'   system                        linear.  sequential  causal    RYW   mono.read  eventual'
	);
	for (const system of ['primary', 'replica', 'sticky', 'token'] as const) {
		const passed = new Array<number>(MODELS.length + 1).fill(0);
		for (let i = 0; i < HISTORIES; i++) {
			const h = generate(system, 5000 + i);
			MODELS.forEach(([, check], m) => {
				if (check(h)) passed[m] = (passed[m] ?? 0) + 1;
			});
			if (eventual(h) === true) passed[MODELS.length] = (passed[MODELS.length] ?? 0) + 1;
		}
		const pct = (n: number | undefined): string =>
			`${Math.round(((n ?? 0) / HISTORIES) * 100)}%`.padStart(5);
		console.log(
			`   ${labels[system].padEnd(28)} ${pct(passed[0])}    ${pct(passed[1])}     ${pct(passed[2])}   ${pct(passed[3])}    ${pct(passed[4])}     ${pct(passed[5])}`
		);
	}
	console.log(
		'\n   100% means "never broken in these 300 histories" — not a proof. Below 100% means it definitely breaks.\n'
	);
}

main();
