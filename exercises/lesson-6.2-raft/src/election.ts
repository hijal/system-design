import { mulberry32, percentile } from './random';
import { RaftNode, type Message } from './raft';
import { Network, Sim } from './sim';

// Lesson 6.2 §1.4 - why is Raft's election timeout random?
//
// 5 nodes start together, nobody is leader. Each node becomes candidate once its own election timeout passes.
// 1000 runs for each timeout range: how long until there is a leader, and how many terms are spent
// (every extra term means one failed election - a split vote).
//
// One-way network trip: a minimum of 2 ms + 2 ms more on average (like different data centers in one region).
// ±0.5 ms of jitter on every timer - real timers never fire at exactly the right time.

const NODES = ['n1', 'n2', 'n3', 'n4', 'n5'];
const TRIALS = 1000;
const GIVE_UP_MS = 10_000;
const RANGES: [number, number][] = [
	[150, 150],
	[150, 155],
	[150, 175],
	[150, 300]
];

type Trial = { electedAt: number | null; terms: number };

function trial(min: number, max: number, seed: number): Trial {
	const sim = new Sim();
	const random = mulberry32(seed);
	const network = new Network<Message>(sim, random);
	let electedAt: number | null = null;
	const nodes = NODES.map(
		(id) =>
			new RaftNode(
				id,
				NODES.filter((peer) => peer !== id),
				{
					sim,
					network,
					random,
					electionMinMs: min,
					electionMaxMs: max,
					heartbeatMs: 50,
					electionRestriction: true,
					onEvent: (event) => {
						if (event.kind === 'leader' && electedAt === null) electedAt = sim.now;
					}
				}
			)
	);
	for (const node of nodes) node.start();
	sim.runUntil(GIVE_UP_MS, () => electedAt !== null);
	return { electedAt, terms: Math.max(...nodes.map((n) => n.term)) };
}

function main(): void {
	console.log(
		`\n   ${NODES.length} nodes start together, nobody is leader - ${TRIALS} runs for each range`
	);
	console.log('   (seeded simulation - exactly the same result every time)\n');
	console.log(
		'   election timeout     leader found          time p50 / p99          avg terms (1 = first try)'
	);
	for (const [min, max] of RANGES) {
		const results = Array.from({ length: TRIALS }, (_, i) => trial(min, max, 1000 + i));
		const elected = results.filter(
			(r): r is { electedAt: number; terms: number } => r.electedAt !== null
		);
		const times = elected.map((r) => r.electedAt);
		const avgTerms = elected.length
			? (elected.reduce((sum, r) => sum + r.terms, 0) / elected.length).toFixed(2)
			: '-';
		const label = min === max ? `${min} ms (fixed)` : `${min}–${max} ms`;
		const timeCol = elected.length
			? `${percentile(times, 50).toFixed(0).padStart(5)} / ${percentile(times, 99).toFixed(0).padStart(5)} ms`
			: '        -         ';
		console.log(
			`   ${label.padEnd(18)}   ${`${elected.length}/${TRIALS}`.padStart(9)}          ${timeCol}         ${avgTerms}`
		);
	}
	console.log(
		`\n   "leader found" = within ${GIVE_UP_MS / 1000} seconds. Without one, the cluster could not take writes for the whole time.\n`
	);
}

main();
