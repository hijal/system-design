import { mulberry32, percentile } from './random';
import { RaftNode, type Message } from './raft';
import { Network, Sim } from './sim';

// Lesson 6.2 §১.৪ — কেন Raft এর election timeout random?
//
// ৫টা node একসাথে চালু হয়, কেউ leader না। প্রতিটা node নিজের election timeout পেরোলে candidate হয়।
// Timeout এর range বদলে বদলে ১০০০ বার করে: কতক্ষণে leader পাওয়া যায়, আর কতগুলো term খরচ হয়
// (প্রতিটা বাড়তি term মানে একটা ব্যর্থ election — split vote)।
//
// Network এর এক দিকের যাত্রা: ন্যূনতম 2 ms + গড়ে আরও 2 ms (একই region এর ভিন্ন data center এর মতো)।
// প্রতিটা timer এ ±0.5 ms এর jitter — বাস্তবের timer কখনো একদম ঠিক সময়ে fire করে না।

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
		`\n   ${NODES.length}টা node একসাথে চালু, কেউ leader না — প্রতিটা range এ ${TRIALS} বার`
	);
	console.log('   (seed দেওয়া simulation — প্রতিবার হুবহু একই ফল)\n');
	console.log(
		'   election timeout     leader পাওয়া গেছে    সময় p50 / p99          গড় term (১ = প্রথম চেষ্টাতেই)'
	);
	for (const [min, max] of RANGES) {
		const results = Array.from({ length: TRIALS }, (_, i) => trial(min, max, 1000 + i));
		const elected = results.filter(
			(r): r is { electedAt: number; terms: number } => r.electedAt !== null
		);
		const times = elected.map((r) => r.electedAt);
		const avgTerms = elected.length
			? (elected.reduce((sum, r) => sum + r.terms, 0) / elected.length).toFixed(2)
			: '—';
		const label = min === max ? `${min} ms (স্থির)` : `${min}–${max} ms`;
		const timeCol = elected.length
			? `${percentile(times, 50).toFixed(0).padStart(5)} / ${percentile(times, 99).toFixed(0).padStart(5)} ms`
			: '        —         ';
		console.log(
			`   ${label.padEnd(18)}   ${`${elected.length}/${TRIALS}`.padStart(9)}          ${timeCol}         ${avgTerms}`
		);
	}
	console.log(
		`\n   "leader পাওয়া গেছে" = ${GIVE_UP_MS / 1000} সেকেন্ডের মধ্যে। না পেলে cluster পুরো সময় লেখা নিতে পারেনি।\n`
	);
}

main();
