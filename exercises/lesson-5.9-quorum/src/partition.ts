// Lesson 5.9 §১.২–১.৩ — network partition এ CAP এর বাছাই, একটা নির্দিষ্ট গল্প দিয়ে।
//
// ৫টা node: n1 n2 n3 (ঢাকা data center)  |  n4 n5 (সিঙ্গাপুর data center)
// দুই data center এর মধ্যের link কেটে গেল। দুই দিকেই user আছে, আর দুজন একই task এর
// title বদলাচ্ছে:
//   রহিম (ঢাকা, সময় ১০০ ms)      → "Fix login"
//   করিম (সিঙ্গাপুর, সময় ২০০ ms) → "Fix signup"   ← আসলে পরের লেখা
//
// একই ঘটনা দুইভাবে:
//   CP — strict quorum (W = R = ৩): যে দিকে majority নেই, সে লেখা/পড়া প্রত্যাখ্যান করে
//   AP — যেকোনো node লেখা নেয় (W = R = ১), পরে last-write-wins (LWW) দিয়ে মেলানো —
//        node এর নিজের ঘড়ির timestamp দিয়ে। আর n4 এর ঘড়ি ৩০০ ms পিছিয়ে (Lesson 6.4)।

type Version = { value: string; timestamp: number; writer: string };
type NodeName = 'n1' | 'n2' | 'n3' | 'n4' | 'n5';

const ALL: NodeName[] = ['n1', 'n2', 'n3', 'n4', 'n5'];
const DHAKA: NodeName[] = ['n1', 'n2', 'n3'];
const SINGAPORE: NodeName[] = ['n4', 'n5'];
const CLOCK_SKEW_MS: Record<NodeName, number> = { n1: 0, n2: 0, n3: 0, n4: -300, n5: 0 };
const QUORUM = 3; // N = ৫, majority = ৩

class Cluster {
	private readonly store = new Map<NodeName, Version>();

	constructor(initial: Version) {
		for (const node of ALL) this.store.set(node, initial);
	}

	// একটা দিক থেকে লেখা: শুধু সেই দিকের node গুলো পৌঁছানো যায়
	write(
		reachable: NodeName[],
		value: string,
		realTime: number,
		writer: string,
		w: number
	): boolean {
		if (reachable.length < w) return false; // W টা node এ পৌঁছানো যাচ্ছে না
		const coordinator = reachable[0] ?? 'n1';
		// timestamp দেয় coordinator node নিজের ঘড়ি দিয়ে — ঘড়ি ভুল হলে timestamp ও ভুল
		const version: Version = { value, timestamp: realTime + CLOCK_SKEW_MS[coordinator], writer };
		for (const node of reachable) this.store.set(node, version);
		return true;
	}

	read(reachable: NodeName[], r: number): Version | undefined {
		if (reachable.length < r) return undefined;
		const answers = reachable.slice(0, r).map((n) => this.store.get(n));
		return answers.reduce<Version | undefined>(
			(best, v) => (v && (!best || v.timestamp > best.timestamp) ? v : best),
			undefined
		);
	}

	// Network জোড়া লাগার পর — সব node কে সবচেয়ে বড় timestamp এর version এ আনা (LWW)
	healWithLastWriteWins(): Version | undefined {
		const winner = this.read(ALL, ALL.length);
		if (winner) for (const node of ALL) this.store.set(node, winner);
		return winner;
	}

	// LWW এর বদলে — আলাদা আলাদা version গুলো রেখে দেওয়া (sibling), app বা user মেলাবে
	distinctVersions(): Version[] {
		const seen = new Map<string, Version>();
		for (const v of this.store.values()) seen.set(`${v.value}@${v.timestamp}`, v);
		return [...seen.values()];
	}
}

const initial: Version = { value: 'Login bug', timestamp: 0, writer: 'শুরুর মান' };
const show = (v: Version | undefined): string => (v ? `"${v.value}"` : '✗ উত্তর নেই (quorum নেই)');

function cp(): void {
	console.log('\nক. CP — strict quorum (N=5, W=3, R=3)');
	const cluster = new Cluster(initial);
	const rahim = cluster.write(DHAKA, 'Fix login', 100, 'রহিম', QUORUM);
	const karim = cluster.write(SINGAPORE, 'Fix signup', 200, 'করিম', QUORUM);
	console.log(
		`   রহিম (ঢাকা, ৩টা node)       লিখল "Fix login"   → ${rahim ? 'সফল ✓' : 'ব্যর্থ ✗'}`
	);
	console.log(
		`   করিম (সিঙ্গাপুর, ২টা node)  লিখল "Fix signup"  → ${karim ? 'সফল ✓' : 'ব্যর্থ ✗ — error দেখল, আবার চেষ্টা করতে হবে'}`
	);
	console.log(
		`   partition চলাকালীন পড়া: ঢাকা → ${show(cluster.read(DHAKA, QUORUM))},  সিঙ্গাপুর → ${show(cluster.read(SINGAPORE, QUORUM))}`
	);
	console.log(`   network জোড়া লাগার পর সবাই পড়ে: ${show(cluster.read(ALL, QUORUM))}`);
	console.log(
		'   → সবাই সবসময় একই সত্য দেখেছে (consistent), কিন্তু সিঙ্গাপুরের user রা ততক্ষণ কাজ করতে পারেনি'
	);
}

function ap(): void {
	console.log(
		'\nখ. AP — যেকোনো node লেখা নেয় (W=1, R=1), পরে last-write-wins; n4 এর ঘড়ি ৩০০ ms পিছিয়ে'
	);
	const cluster = new Cluster(initial);
	cluster.write(DHAKA, 'Fix login', 100, 'রহিম', 1);
	cluster.write(SINGAPORE, 'Fix signup', 200, 'করিম', 1); // coordinator = n4 (তালিকার প্রথম)
	console.log('   রহিম (ঢাকা)      লিখল "Fix login"  আসল সময় ১০০ ms → সফল ✓');
	console.log(
		'   করিম (সিঙ্গাপুর) লিখল "Fix signup" আসল সময় ২০০ ms → সফল ✓  (coordinator n4, ঘড়ি ৩০০ ms পিছিয়ে)'
	);
	console.log(
		`   partition চলাকালীন পড়া: ঢাকা → ${show(cluster.read(DHAKA, 1))},  সিঙ্গাপুর → ${show(cluster.read(SINGAPORE, 1))}  ← দুই দিকে দুই সত্য`
	);

	const siblings = cluster.distinctVersions().filter((v) => v.writer !== initial.writer);
	console.log('   network জোড়া লাগল — দুটো version পাওয়া গেল:');
	for (const v of siblings)
		console.log(`     "${v.value}" (${v.writer}), timestamp ${v.timestamp} ms`);

	const winner = cluster.healWithLastWriteWins();
	console.log(`   LWW বিজয়ী: ${show(winner)} (${winner?.writer ?? '?'})`);
	console.log('   → দুজনেই "saved" দেখেছিল; করিমের লেখা আসলে পরে হয়েছিল, তবু নীরবে হারিয়ে গেল —');
	console.log('     কারণ "পরে" ঠিক হলো একটা ভুল ঘড়ি দিয়ে। কোনো error নেই, কোনো log নেই।');
}

function main(): void {
	console.log('\n   ৫টা node: n1 n2 n3 (ঢাকা) | n4 n5 (সিঙ্গাপুর) — মাঝের network link কাটা');
	cp();
	ap();
	console.log('');
}

main();
