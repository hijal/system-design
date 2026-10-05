import { z } from 'zod';
import { mulberry32 } from './random';
import { RaftNode, type Message, type RaftEvent } from './raft';
import { Network, Sim } from './sim';

// Lesson 6.2 §1.5–1.7 — what Raft does in a partition, and why there is no split brain.
//
// 5 nodes. First a leader (L) is elected and x=1 is written. Then the network splits three ways:
//   [L]            — the old leader, isolated alone
//   [F]            — one follower, isolated alone (its term keeps going up — you'll see why)
//   [the other 3]  — the majority
// Client A writes x=2 to the old leader; client B writes x=3 to the new leader. Then the network heals.
//
//   npm run partition  → real Raft
//   npm run unsafe     → the "election restriction" off: a node with an old log also gets votes

const mode = z.enum(['safe', 'unsafe']).parse(process.argv[2]);
const NODES = ['n1', 'n2', 'n3', 'n4', 'n5'];
const CLIENT_TIMEOUT_MS = 1000;

const sim = new Sim();
const random = mulberry32(7);
const network = new Network<Message>(sim, random);

const lines: string[] = [];
function say(who: string, text: string): void {
	lines.push(`   ${String(Math.round(sim.now)).padStart(5)} ms  ${who.padEnd(6)}  ${text}`);
}

type Pending = {
	client: string;
	node: string;
	index: number;
	term: number;
	command: string;
	at: number;
	done: boolean;
};
const pending: Pending[] = [];

function onEvent(event: RaftEvent): void {
	switch (event.kind) {
		case 'candidate':
			return; // the isolated F becomes candidate again and again — instead of printing each one, show its term in the snapshot
		case 'leader':
			return say(event.node, `★ became leader (term ${event.term})`);
		case 'step-down':
			return say(
				event.node,
				`saw term ${event.newTerm} → no longer leader (was term ${event.oldTerm})`
			);
		case 'vote-rejected-log':
			return say(
				event.node,
				`did not vote for ${event.candidate} — its log is older than mine (term ${event.term})`
			);
		case 'commit': {
			say(event.node, `commit: index ${event.index} "${event.command}"`);
			for (const p of pending)
				if (!p.done && p.node === event.node && p.index === event.index && p.term === event.term) {
					p.done = true;
					say(p.client, `✓ "${p.command}" confirmed (${Math.round(sim.now - p.at)} ms)`);
				}
		}
	}
}

const nodes = NODES.map(
	(id) =>
		new RaftNode(
			id,
			NODES.filter((peer) => peer !== id),
			{
				sim,
				network,
				random,
				electionMinMs: 150,
				electionMaxMs: 300,
				heartbeatMs: 50,
				electionRestriction: mode === 'safe',
				onEvent
			}
		)
);

function leaders(): RaftNode[] {
	return nodes.filter((n) => n.isLeader);
}

function write(client: string, target: RaftNode, command: string): void {
	const result = target.submit(command);
	if (!result) return say(client, `"${command}" → ${target.id} is not leader, rejected`);
	say(client, `"${command}" → ${target.id} (log index ${result.index}, term ${result.term})`);
	const p: Pending = { client, node: target.id, ...result, command, at: sim.now, done: false };
	pending.push(p);
	sim.schedule(CLIENT_TIMEOUT_MS, () => {
		if (!p.done)
			say(client, `✗ "${command}" — no confirmation within ${CLIENT_TIMEOUT_MS} ms (timeout)`);
	});
}

function snapshot(title: string): void {
	lines.push('', `   ── ${title} ──`);
	for (const n of nodes) {
		const role = n.isLeader ? 'LEADER' : n.role.kind;
		const log = n.log.map((e) => `${e.command}(t${e.term})`).join(' ') || '—';
		lines.push(
			`   ${n.id}  ${role.padEnd(9)} term ${String(n.term).padStart(2)}   log: ${log.padEnd(30)} commit ${n.commitIndex}   x = ${n.kv.get('x') ?? '—'}`
		);
	}
	lines.push('');
}

function main(): void {
	for (const n of nodes) n.start();
	sim.runUntil(1000);
	const [first] = leaders();
	if (!first) throw new Error('no leader elected');
	const L = first;
	const F = nodes.find((n) => n !== L);
	if (!F) throw new Error('no follower');
	const majority = nodes.filter((n) => n !== L && n !== F);

	write('client', L, 'x=1');
	sim.runUntil(1200);

	network.partition([[L.id], [F.id], majority.map((n) => n.id)]);
	lines.push(
		'',
		`   ═══ ${Math.round(sim.now)} ms: network cut — [${L.id}] | [${F.id}] | [${majority.map((n) => n.id).join(' ')}] ═══`,
		''
	);

	sim.runUntil(1250);
	write('A', L, 'x=2'); // to the old leader — it still thinks it is leader
	sim.runUntil(2000);

	const newLeader = leaders().find((n) => n !== L);
	if (newLeader) write('B', newLeader, 'x=3');
	sim.runUntil(2300);
	snapshot('partition in progress — two "leaders"?');

	sim.runUntil(3500);
	network.heal();
	lines.push(`   ═══ ${Math.round(sim.now)} ms: network healed ═══`, '');
	sim.runUntil(4500);

	const current = leaders()[0];
	if (current) write('C', current, 'x=4');
	sim.runUntil(5000);
	snapshot('final state');

	console.log(
		`\n   ${mode === 'safe' ? 'SAFE — real Raft' : 'UNSAFE — election restriction off'}  (5 nodes, election timeout 150–300 ms)\n`
	);
	console.log(lines.join('\n'));

	const committedX3 = pending.find((p) => p.command === 'x=3')?.done ?? false;
	const survivors = nodes.filter((n) => n.log.some((e) => e.command === 'x=3')).length;
	console.log('   ── result ──');
	console.log(`   "x=3" was confirmed to the client: ${committedX3 ? 'yes' : 'no'}`);
	console.log(
		`   how many nodes have "x=3" in their log now: ${survivors}/5` +
			(committedX3 && survivors === 0 ? '   ← a confirmed write has been lost!' : '')
	);
	console.log(
		`   "x=2" (never confirmed) is in how many logs: ${nodes.filter((n) => n.log.some((e) => e.command === 'x=2')).length}/5`
	);
	const values = new Set(nodes.map((n) => n.kv.get('x') ?? '—'));
	console.log(
		`   is x the same on every node? ${values.size === 1 ? 'yes' : `no — ${nodes.map((n) => `${n.id}=${n.kv.get('x') ?? '—'}`).join(' ')}   ← the replicas have diverged!`}\n`
	);
}

main();
