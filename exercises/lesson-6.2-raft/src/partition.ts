import { z } from 'zod';
import { mulberry32 } from './random';
import { RaftNode, type Message, type RaftEvent } from './raft';
import { Network, Sim } from './sim';

// Lesson 6.2 §১.৫–১.৭ — Raft একটা partition এ কী করে, আর কেন split brain হয় না।
//
// ৫টা node। প্রথমে একজন leader (L) নির্বাচিত হয়, x=1 লেখা হয়। তারপর network তিন ভাগ:
//   [L]            — পুরনো leader একা বিচ্ছিন্ন
//   [F]            — একজন follower একা বিচ্ছিন্ন (তার term বাড়তেই থাকবে — দেখবে কেন)
//   [বাকি ৩ জন]    — majority
// Client A পুরনো leader কে x=2 লেখে; client B নতুন leader কে x=3 লেখে। তারপর network জোড়া লাগে।
//
//   npm run partition  → আসল Raft
//   npm run unsafe     → "election restriction" বন্ধ: পুরনো log এর node ও ভোট পায়

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
			return; // বিচ্ছিন্ন F বারবার candidate হয় — আলাদা করে না ছেপে snapshot এ term দেখাই
		case 'leader':
			return say(event.node, `★ leader হলো (term ${event.term})`);
		case 'step-down':
			return say(
				event.node,
				`term ${event.newTerm} দেখল → আর leader না (ছিল term ${event.oldTerm})`
			);
		case 'vote-rejected-log':
			return say(
				event.node,
				`${event.candidate} কে ভোট দিল না — ওর log আমার চেয়ে পুরনো (term ${event.term})`
			);
		case 'commit': {
			say(event.node, `commit: index ${event.index} "${event.command}"`);
			for (const p of pending)
				if (!p.done && p.node === event.node && p.index === event.index && p.term === event.term) {
					p.done = true;
					say(p.client, `✓ "${p.command}" নিশ্চিত (${Math.round(sim.now - p.at)} ms)`);
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
	if (!result) return say(client, `"${command}" → ${target.id} leader না, প্রত্যাখ্যান`);
	say(client, `"${command}" → ${target.id} (log index ${result.index}, term ${result.term})`);
	const p: Pending = { client, node: target.id, ...result, command, at: sim.now, done: false };
	pending.push(p);
	sim.schedule(CLIENT_TIMEOUT_MS, () => {
		if (!p.done)
			say(client, `✗ "${command}" — ${CLIENT_TIMEOUT_MS} ms এ কোনো নিশ্চয়তা আসেনি (timeout)`);
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
		`   ═══ ${Math.round(sim.now)} ms: network কাটা — [${L.id}] | [${F.id}] | [${majority.map((n) => n.id).join(' ')}] ═══`,
		''
	);

	sim.runUntil(1250);
	write('A', L, 'x=2'); // পুরনো leader এর কাছে — সে এখনো নিজেকে leader ভাবে
	sim.runUntil(2000);

	const newLeader = leaders().find((n) => n !== L);
	if (newLeader) write('B', newLeader, 'x=3');
	sim.runUntil(2300);
	snapshot('partition চলছে — দুজন "leader"?');

	sim.runUntil(3500);
	network.heal();
	lines.push(`   ═══ ${Math.round(sim.now)} ms: network জোড়া লাগল ═══`, '');
	sim.runUntil(4500);

	const current = leaders()[0];
	if (current) write('C', current, 'x=4');
	sim.runUntil(5000);
	snapshot('শেষ অবস্থা');

	console.log(
		`\n   ${mode === 'safe' ? 'SAFE — আসল Raft' : 'UNSAFE — election restriction বন্ধ'}  (৫ node, election timeout 150–300 ms)\n`
	);
	console.log(lines.join('\n'));

	const committedX3 = pending.find((p) => p.command === 'x=3')?.done ?? false;
	const survivors = nodes.filter((n) => n.log.some((e) => e.command === 'x=3')).length;
	console.log('   ── ফল ──');
	console.log(`   "x=3" client কে নিশ্চিত করা হয়েছিল: ${committedX3 ? 'হ্যাঁ' : 'না'}`);
	console.log(
		`   "x=3" এখন কয়টা node এর log এ আছে: ${survivors}/5` +
			(committedX3 && survivors === 0 ? '   ← নিশ্চিত করা লেখা হারিয়ে গেছে!' : '')
	);
	console.log(
		`   "x=2" (কখনো নিশ্চিত হয়নি) কয়টা log এ আছে: ${nodes.filter((n) => n.log.some((e) => e.command === 'x=2')).length}/5`
	);
	const values = new Set(nodes.map((n) => n.kv.get('x') ?? '—'));
	console.log(
		`   সব node এ x এর মান এক? ${values.size === 1 ? 'হ্যাঁ' : `না — ${nodes.map((n) => `${n.id}=${n.kv.get('x') ?? '—'}`).join(' ')}   ← replica গুলো আলাদা হয়ে গেছে!`}\n`
	);
}

main();
