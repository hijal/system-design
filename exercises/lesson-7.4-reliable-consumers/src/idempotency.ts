// Lesson 7.4 §1.2 — Idempotent consumer: five strategies, counting **every** crash point and **every**
// interleaving of each.
//
// The job: "send an email to the user mentioned in a comment". The queue is at-least-once (7.2, 7.3), so the same message
// can arrive again — in two ways:
//   (a) the first delivery crashed halfway, no ack → the broker delivered it again (one after the other)
//   (b) the first worker was stuck so its lock expired, a second worker picked it up too → both **at once** (7.3's stalled)
//
// Every step is taken as atomic (one database statement, one API call). Nothing is random — every possibility
// is counted, so the output is exactly the same every time.

type Status = 'pending' | 'sent';

interface World {
	// processed_messages / sent_notifications table — a unique constraint on key
	db: Map<string, Status>;
	// how many emails the user actually got (or how many times the counter went up) — this is what we measure
	effects: number;
	// the provider's own idempotency: it does not send a key it has seen before again
	providerKeys: Set<string>;
	acked: boolean;
}

// 'skip' means "the work is already done" — skip the remaining steps and ack directly
type StepResult = 'next' | 'skip';
interface Step {
	label: string;
	run: (w: World) => StepResult;
}
interface Strategy {
	name: string;
	steps: Step[]; // the last step is always ack
}

const KEY = 'mention:comment-42:user-7';

const send: Step = {
	label: 'email sent',
	run: (w) => {
		w.effects++;
		return 'next';
	}
};
const sendWithKey: Step = {
	label: 'email sent (with provider key)',
	run: (w) => {
		if (!w.providerKeys.has(KEY)) {
			w.providerKeys.add(KEY);
			w.effects++;
		}
		return 'next';
	}
};
const ack: Step = {
	label: 'ack',
	run: (w) => {
		w.acked = true;
		return 'next';
	}
};

// skip if 'sent'; if 'pending', someone before stopped halfway — the work has to be tried again
const claimPending: Step = {
	label: 'claimed (pending)',
	run: (w) => {
		const status = w.db.get(KEY);
		if (status === 'sent') return 'skip';
		if (status === undefined) w.db.set(KEY, 'pending');
		return 'next';
	}
};
const markSent: Step = {
	label: 'wrote sent',
	run: (w) => {
		w.db.set(KEY, 'sent');
		return 'next';
	}
};

const strategies: Strategy[] = [
	{ name: '1. nothing: send → ack', steps: [send, ack] },
	{
		name: '2. check first: check → send → insert → ack',
		steps: [
			{ label: 'checked the table', run: (w) => (w.db.has(KEY) ? 'skip' : 'next') },
			send,
			{
				label: 'wrote to the table',
				run: (w) => {
					w.db.set(KEY, 'sent');
					return 'next';
				}
			},
			ack
		]
	},
	{
		name: '3. claim first: insert (unique) → send → ack',
		steps: [
			{
				label: 'claimed in the table',
				// INSERT … ON CONFLICT DO NOTHING — skip if the row already exists
				run: (w) => {
					if (w.db.has(KEY)) return 'skip';
					w.db.set(KEY, 'sent');
					return 'next';
				}
			},
			send,
			ack
		]
	},
	{
		name: '4. claim + state (no provider key)',
		steps: [claimPending, send, markSent, ack]
	},
	{
		name: '5. claim + state + provider key',
		steps: [claimPending, sendWithKey, markSent, ack]
	},
	{
		name: '6. one transaction (effect in the database)',
		steps: [
			{
				label: 'transaction: claim + effect',
				// BEGIN; INSERT processed_messages …; UPDATE usage SET count = count + 1; COMMIT
				// — both happen together or neither does
				run: (w) => {
					if (w.db.has(KEY)) return 'skip';
					w.db.set(KEY, 'sent');
					w.effects++;
					return 'next';
				}
			},
			ack
		]
	}
];

function freshWorld(): World {
	return { db: new Map(), effects: 0, providerKeys: new Set(), acked: false };
}

function cloneWorld(w: World): World {
	return {
		db: new Map(w.db),
		effects: w.effects,
		providerKeys: new Set(w.providerKeys),
		acked: w.acked
	};
}

// one delivery moves one step forward; returns the index of the next step (steps.length means done)
function stepOnce(strategy: Strategy, pc: number, w: World): number {
	const step = strategy.steps[pc];
	if (!step) return strategy.steps.length;
	const result = step.run(w);
	return result === 'skip' ? strategy.steps.length - 1 : pc + 1;
}

// (a) the first delivery dies after step `crashAfter` (null = never dies); without an ack the second delivery runs in full
function crashThenRedeliver(strategy: Strategy, crashAfter: number | null): number {
	const w = freshWorld();
	let pc = 0;
	while (pc < strategy.steps.length) {
		const current = pc;
		pc = stepOnce(strategy, pc, w);
		if (current === crashAfter) break;
	}
	if (!w.acked) {
		let pc2 = 0;
		while (pc2 < strategy.steps.length) pc2 = stepOnce(strategy, pc2, w);
	}
	return w.effects;
}

// (b) two deliveries at once: at every moment, who runs the next step — counting every possible order
function allInterleavings(strategy: Strategy): number[] {
	const outcomes: number[] = [];
	const explore = (w: World, a: number, b: number): void => {
		const n = strategy.steps.length;
		if (a >= n && b >= n) {
			outcomes.push(w.effects);
			return;
		}
		if (a < n) {
			const next = cloneWorld(w);
			explore(next, stepOnce(strategy, a, next), b);
		}
		if (b < n) {
			const next = cloneWorld(w);
			explore(next, a, stepOnce(strategy, b, next));
		}
	};
	explore(freshWorld(), 0, 0);
	return outcomes;
}

const verdict = (effects: number): string =>
	effects === 1 ? '1 ✓' : effects === 0 ? '0 ✗ lost' : `${effects} ✗ twice`;

console.log('\n── (a) crash, then delivery again ─────────────────────────────────────────');
console.log(
	'   assuming a crash after each step (up to before the ack): how many emails the user got\n'
);
const summary: { name: string; lost: number; dup: number; points: number; race: number[] }[] = [];
for (const strategy of strategies) {
	console.log(`   ${strategy.name}`);
	let lost = 0;
	let dup = 0;
	const points = strategy.steps.length - 1; // a crash after the ack means the work is done — no need to count it
	console.log(`        ${'no crash'.padEnd(44)} ${verdict(crashThenRedeliver(strategy, null))}`);
	for (let c = 0; c < points; c++) {
		const effects = crashThenRedeliver(strategy, c);
		if (effects === 0) lost++;
		if (effects > 1) dup++;
		const label = `crash after "${strategy.steps[c]?.label ?? '?'}"`;
		console.log(`        ${label.padEnd(44)} ${verdict(effects)}`);
	}
	summary.push({ name: strategy.name, lost, dup, points, race: allInterleavings(strategy) });
	console.log('');
}

console.log('── (b) two workers on the same message at once (stalled) ──────────────────');
console.log(
	'   every order in which the steps of the two deliveries can interleave — all of them\n'
);
for (const s of summary) {
	const twice = s.race.filter((e) => e > 1).length;
	const none = s.race.filter((e) => e === 0).length;
	console.log(
		`   ${s.name.padEnd(44)} ${String(s.race.length).padStart(3)} orders → twice ${twice}${none ? `, lost ${none}` : ''}`
	);
}

console.log('\n── summary ────────────────────────────────────────────────────────────────');
console.log(
	'   strategy                                     crash: lost / twice    concurrent: twice'
);
for (const s of summary) {
	const twice = s.race.filter((e) => e > 1).length;
	console.log(
		`   ${s.name.padEnd(44)} ${`${s.lost} / ${s.dup}`.padStart(9)} ${`(${s.points} point${s.points === 1 ? '' : 's'})`.padEnd(10)}   ${`${twice} / ${s.race.length}`.padStart(17)}`
	);
}
