// Lesson 5.9 §1.2–1.3 - the CAP choice in a network partition, told through one concrete story.
//
// 5 nodes: n1 n2 n3 (Dhaka data center)  |  n4 n5 (Singapore data center)
// The link between the two data centers is cut. There are users on both sides, and two of them are changing
// the title of the same task:
//   Rahim (Dhaka, at 100 ms)      → "Fix login"
//   Karim (Singapore, at 200 ms)  → "Fix signup"   ← actually the later write
//
// The same event, two ways:
//   CP - strict quorum (W = R = 3): the side without a majority rejects writes/reads
//   AP - any node takes writes (W = R = 1), reconciled later with last-write-wins (LWW) -
//        using the timestamp from the node's own clock. And n4's clock is 300 ms behind (Lesson 6.4).

type Version = { value: string; timestamp: number; writer: string };
type NodeName = 'n1' | 'n2' | 'n3' | 'n4' | 'n5';

const ALL: NodeName[] = ['n1', 'n2', 'n3', 'n4', 'n5'];
const DHAKA: NodeName[] = ['n1', 'n2', 'n3'];
const SINGAPORE: NodeName[] = ['n4', 'n5'];
const CLOCK_SKEW_MS: Record<NodeName, number> = { n1: 0, n2: 0, n3: 0, n4: -300, n5: 0 };
const QUORUM = 3; // N = 5, majority = 3

class Cluster {
	private readonly store = new Map<NodeName, Version>();

	constructor(initial: Version) {
		for (const node of ALL) this.store.set(node, initial);
	}

	// a write from one side: only the nodes on that side can be reached
	write(
		reachable: NodeName[],
		value: string,
		realTime: number,
		writer: string,
		w: number
	): boolean {
		if (reachable.length < w) return false; // can't reach W nodes
		const coordinator = reachable[0] ?? 'n1';
		// the coordinator node stamps the timestamp with its own clock - if the clock is wrong, so is the timestamp
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

	// After the network heals - bring every node to the version with the largest timestamp (LWW)
	healWithLastWriteWins(): Version | undefined {
		const winner = this.read(ALL, ALL.length);
		if (winner) for (const node of ALL) this.store.set(node, winner);
		return winner;
	}

	// Instead of LWW - keep the separate versions (siblings), for the app or the user to reconcile
	distinctVersions(): Version[] {
		const seen = new Map<string, Version>();
		for (const v of this.store.values()) seen.set(`${v.value}@${v.timestamp}`, v);
		return [...seen.values()];
	}
}

const initial: Version = { value: 'Login bug', timestamp: 0, writer: 'initial value' };
const show = (v: Version | undefined): string => (v ? `"${v.value}"` : '✗ no answer (no quorum)');

function cp(): void {
	console.log('\nA. CP - strict quorum (N=5, W=3, R=3)');
	const cluster = new Cluster(initial);
	const rahim = cluster.write(DHAKA, 'Fix login', 100, 'Rahim', QUORUM);
	const karim = cluster.write(SINGAPORE, 'Fix signup', 200, 'Karim', QUORUM);
	console.log(
		`   Rahim (Dhaka, 3 nodes)         wrote "Fix login"   → ${rahim ? 'success ✓' : 'failed ✗'}`
	);
	console.log(
		`   Karim (Singapore, 2 nodes)     wrote "Fix signup"  → ${karim ? 'success ✓' : 'failed ✗ - saw an error, has to try again'}`
	);
	console.log(
		`   reads during the partition: Dhaka → ${show(cluster.read(DHAKA, QUORUM))},  Singapore → ${show(cluster.read(SINGAPORE, QUORUM))}`
	);
	console.log(`   after the network heals, everyone reads: ${show(cluster.read(ALL, QUORUM))}`);
	console.log(
		'   → everyone always saw the same truth (consistent), but the Singapore users could not work meanwhile'
	);
}

function ap(): void {
	console.log(
		"\nB. AP - any node takes writes (W=1, R=1), last-write-wins afterwards; n4's clock is 300 ms behind"
	);
	const cluster = new Cluster(initial);
	cluster.write(DHAKA, 'Fix login', 100, 'Rahim', 1);
	cluster.write(SINGAPORE, 'Fix signup', 200, 'Karim', 1); // coordinator = n4 (first in the list)
	console.log('   Rahim (Dhaka)       wrote "Fix login"  real time 100 ms → success ✓');
	console.log(
		'   Karim (Singapore)   wrote "Fix signup" real time 200 ms → success ✓  (coordinator n4, clock 300 ms behind)'
	);
	console.log(
		`   reads during the partition: Dhaka → ${show(cluster.read(DHAKA, 1))},  Singapore → ${show(cluster.read(SINGAPORE, 1))}  ← two truths on two sides`
	);

	const siblings = cluster.distinctVersions().filter((v) => v.writer !== initial.writer);
	console.log('   the network healed - two versions found:');
	for (const v of siblings)
		console.log(`     "${v.value}" (${v.writer}), timestamp ${v.timestamp} ms`);

	const winner = cluster.healWithLastWriteWins();
	console.log(`   LWW winner: ${show(winner)} (${winner?.writer ?? '?'})`);
	console.log(
		'   → both saw "saved"; Karim\'s write really happened later, yet it was silently lost -'
	);
	console.log('     because "later" was decided by a wrong clock. No error, no log.');
}

function main(): void {
	console.log(
		'\n   5 nodes: n1 n2 n3 (Dhaka) | n4 n5 (Singapore) - the network link between them cut'
	);
	cp();
	ap();
	console.log('');
}

main();
