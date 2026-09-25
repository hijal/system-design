import { eventual, MODELS, type History, type Op } from './checker';
import { latency, mulberry32 } from './random';

// Lesson 6.5 §১.৭ — Jepsen এর ধারণা, ছোট করে: একটা system চালাও, সব operation এর history রেকর্ড করো,
// তারপর checker দিয়ে যাচাই করো কোন consistency model সে আসলে দেয়।
//
// চারটা system, প্রতিটায় ৩০০টা random history (৩ জন client, প্রত্যেকে ৫টা operation, একটা key):
//   primary  — সব read আর write একটা primary তে
//   replica  — write primary তে, read দুটো async replica এর যেকোনোটায় (Lesson 5.7, 6.3)
//   sticky   — প্রতিটা client সবসময় একই replica থেকে পড়ে
//   token    — version token: client এর দেখা/লেখা সবচেয়ে নতুন version এর চেয়ে পিছিয়ে থাকা replica
//              থেকে পড়ে না, তখন primary তে যায় (Lesson 6.3)
// সবশেষে প্রতিটা client ১ সেকেন্ড পরে একবার পড়ে — eventual যাচাইয়ের জন্য।

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
			const last = i === OPS_EACH; // শেষেরটা ১ s পরে একটা read
			if (last) t += 1000;
			const kind = !last && random() < 0.35 ? 'write' : 'read';
			const start = t;
			const end = t + 2 + random() * 8;
			// operation টা আসলে কখন কার্যকর হলো — শুরু আর শেষের মাঝে কোনো এক মুহূর্তে
			const at = start + random() * (end - start);
			planned.push({ process, kind, start, end, at, value: kind === 'write' ? nextValue++ : 0 });
			t = end + random() * 20;
		}
	}

	// Primary তে write গুলো কার্যকর হওয়ার ক্রমে — এটাই primary এর log
	const log = planned.filter((p) => p.kind === 'write').sort((a, b) => a.at - b.at);
	// প্রতিটা replica তে প্রতিটা write কখন দেখা যায় — lag, মাঝে মাঝে বড়, আর ক্রমানুসারে
	const visible = [0, 1].map(() => {
		let prev = 0;
		return log.map((wr) => {
			const lag = latency(random, 1, 5) + (random() < 0.05 ? 100 : 0);
			prev = Math.max(prev, wr.at + lag);
			return prev;
		});
	});
	const upTo = (times: number[], t: number): number => times.filter((x) => x <= t).length; // কয়টা write প্রয়োগ হয়েছে
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
		primary: 'এক primary',
		replica: 'যেকোনো replica',
		sticky: 'client প্রতি একটা replica',
		token: 'version token'
	};
	console.log(
		`\n   প্রতিটা system এ ${HISTORIES}টা random history (${CLIENTS.length} client × ${OPS_EACH + 1} op) — কত শতাংশ কোন model মানে`
	);
	console.log('   (seed দেওয়া — প্রতিবার একই ফল)\n');
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
		'\n   ১০০% মানে "এই ৩০০টা history তে কখনো ভাঙেনি" — প্রমাণ না। ১০০% এর কম মানে নিশ্চিতভাবে ভাঙে।\n'
	);
}

main();
