// Lesson 7.4 §১.২ — Idempotent consumer: পাঁচটা কৌশল, প্রতিটার **প্রতিটা** crash point আর **প্রতিটা**
// interleaving গুনে দেখা।
//
// কাজ: "comment এ mention করা user কে একটা email পাঠাও"। Queue at-least-once (7.2, 7.3), তাই একই message
// আবার আসতে পারে — দুইভাবে:
//   (ক) প্রথম delivery মাঝপথে crash করল, ack হয়নি → broker আবার দিল (একজনের পরে আরেকজন)
//   (খ) প্রথম worker আটকে থাকায় lock গেল, দ্বিতীয় worker ও তুলে নিল → দুজন **একসাথে** (7.3 এর stalled)
//
// প্রতিটা ধাপ atomic ধরা হয় (একটা database statement, একটা API call)। Random কিছু নেই — সব সম্ভাবনা
// গুনে দেখা হয়, তাই output প্রতিবার হুবহু একই।

type Status = 'pending' | 'sent';

interface World {
	// processed_messages / sent_notifications table — key এর উপর unique constraint
	db: Map<string, Status>;
	// user আসলে কয়টা email পেল (বা counter কতবার বাড়ল) — এটাই মাপার জিনিস
	effects: number;
	// provider এর নিজের idempotency: যে key আগে দেখেছে, সেটা আবার পাঠায় না
	providerKeys: Set<string>;
	acked: boolean;
}

// 'skip' মানে "কাজ আগেই হয়েছে" — বাকি ধাপ বাদ দিয়ে সরাসরি ack
type StepResult = 'next' | 'skip';
interface Step {
	label: string;
	run: (w: World) => StepResult;
}
interface Strategy {
	name: string;
	steps: Step[]; // শেষ ধাপ সবসময় ack
}

const KEY = 'mention:comment-42:user-7';

const send: Step = {
	label: 'email পাঠাল',
	run: (w) => {
		w.effects++;
		return 'next';
	}
};
const sendWithKey: Step = {
	label: 'email পাঠাল (provider key সহ)',
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

// 'sent' হলে skip; 'pending' হলে আগের কেউ মাঝপথে থেমেছে — কাজটা আবার চেষ্টা করতে হবে
const claimPending: Step = {
	label: 'দাবি করল (pending)',
	run: (w) => {
		const status = w.db.get(KEY);
		if (status === 'sent') return 'skip';
		if (status === undefined) w.db.set(KEY, 'pending');
		return 'next';
	}
};
const markSent: Step = {
	label: 'sent লিখল',
	run: (w) => {
		w.db.set(KEY, 'sent');
		return 'next';
	}
};

const strategies: Strategy[] = [
	{ name: '১. কিছু না: send → ack', steps: [send, ack] },
	{
		name: '২. আগে দেখো: check → send → insert → ack',
		steps: [
			{ label: 'table দেখল', run: (w) => (w.db.has(KEY) ? 'skip' : 'next') },
			send,
			{
				label: 'table এ লিখল',
				run: (w) => {
					w.db.set(KEY, 'sent');
					return 'next';
				}
			},
			ack
		]
	},
	{
		name: '৩. আগে দাবি: insert (unique) → send → ack',
		steps: [
			{
				label: 'table এ দাবি করল',
				// INSERT … ON CONFLICT DO NOTHING — সারি আগে থাকলে skip
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
		name: '৪. দাবি + অবস্থা (provider key ছাড়া)',
		steps: [claimPending, send, markSent, ack]
	},
	{
		name: '৫. দাবি + অবস্থা + provider key',
		steps: [claimPending, sendWithKey, markSent, ack]
	},
	{
		name: '৬. একই transaction (effect টা database এ)',
		steps: [
			{
				label: 'transaction: দাবি + effect',
				// BEGIN; INSERT processed_messages …; UPDATE usage SET count = count + 1; COMMIT
				// — দুটো একসাথে হয় বা কোনোটাই না
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

// একটা delivery এক ধাপ এগোয়; ফেরত দেয় পরের ধাপের index (steps.length মানে শেষ)
function stepOnce(strategy: Strategy, pc: number, w: World): number {
	const step = strategy.steps[pc];
	if (!step) return strategy.steps.length;
	const result = step.run(w);
	return result === 'skip' ? strategy.steps.length - 1 : pc + 1;
}

// (ক) প্রথম delivery ধাপ `crashAfter` এর পরে মরে (null = মরে না); ack না হলে দ্বিতীয় delivery পুরোটা চলে
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

// (খ) দুটো delivery একসাথে: প্রতিটা মুহূর্তে কে পরের ধাপ চালাবে — সব সম্ভাব্য ক্রম গুনে দেখা
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
	effects === 1 ? '1 ✓' : effects === 0 ? '0 ✗ হারাল' : `${effects} ✗ দুবার`;

console.log('\n── (ক) crash, তারপর আবার delivery ─────────────────────────────────────────');
console.log('   প্রতিটা ধাপের পরে crash ধরে (ack এর আগে পর্যন্ত): user কয়টা email পেল\n');
const summary: { name: string; lost: number; dup: number; points: number; race: number[] }[] = [];
for (const strategy of strategies) {
	console.log(`   ${strategy.name}`);
	let lost = 0;
	let dup = 0;
	const points = strategy.steps.length - 1; // ack এর পরে crash মানে কাজ শেষ — গোনার দরকার নেই
	console.log(`        ${'crash নেই'.padEnd(44)} ${verdict(crashThenRedeliver(strategy, null))}`);
	for (let c = 0; c < points; c++) {
		const effects = crashThenRedeliver(strategy, c);
		if (effects === 0) lost++;
		if (effects > 1) dup++;
		const label = `"${strategy.steps[c]?.label ?? '?'}" এর পরে crash`;
		console.log(`        ${label.padEnd(44)} ${verdict(effects)}`);
	}
	summary.push({ name: strategy.name, lost, dup, points, race: allInterleavings(strategy) });
	console.log('');
}

console.log('── (খ) দুজন worker একসাথে একই message (stalled) ────────────────────────────');
console.log('   দুটো delivery র ধাপগুলো যত রকম ক্রমে মিশতে পারে — সবগুলো\n');
for (const s of summary) {
	const twice = s.race.filter((e) => e > 1).length;
	const none = s.race.filter((e) => e === 0).length;
	console.log(
		`   ${s.name.padEnd(44)} ${String(s.race.length).padStart(3)} টা ক্রম → দুবার ${twice}${none ? `, হারাল ${none}` : ''}`
	);
}

console.log('\n── সারাংশ ─────────────────────────────────────────────────────────────────');
console.log(
	'   কৌশল                                         crash: হারাল / দুবার     একসাথে: দুবার'
);
for (const s of summary) {
	const twice = s.race.filter((e) => e > 1).length;
	console.log(
		`   ${s.name.padEnd(44)} ${`${s.lost} / ${s.dup}`.padStart(9)} (${s.points} টা point)   ${`${twice} / ${s.race.length}`.padStart(8)}`
	);
}
