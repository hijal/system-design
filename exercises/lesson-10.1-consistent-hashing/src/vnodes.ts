import { HashRing, type ReplicaRule, loadByNode, node, nodeList, spread } from './ring';
import { hash32 } from './hash';
import { heading, keyNames, pct, ratio, row } from './random';

const KEYS = Number(process.env.KEYS ?? 200_000);
const NODES = Number(process.env.NODES ?? 10);
const keys = keyNames('tasks:board', KEYS);

function balance(): void {
	const nodes = nodeList('cache', NODES);
	heading(
		`A. ${NODES} nodes, ${KEYS.toLocaleString('en-US')} keys — how even the split gets as virtual nodes grow`
	);
	console.log(
		row([
			['vnode / node', 16],
			['heaviest', 14],
			['lightest', 15],
			['points on ring', 15],
			['lookup steps', 15]
		])
	);
	for (const vnodes of [1, 10, 50, 100, 160, 500, 1000]) {
		const ring = new HashRing(nodes, vnodes);
		const { max, min } = spread(loadByNode(ring, keys), nodes);
		let steps = 0;
		for (const key of keys.slice(0, 10_000)) {
			ring.firstIndexAtOrAfter(hash32(key));
			steps += ring.lastSteps;
		}
		console.log(
			row([
				[vnodes, 16],
				[ratio(max), 14],
				[ratio(min), 15],
				[ring.points.length.toLocaleString('en-US'), 15],
				[(steps / 10_000).toFixed(1), 15]
			])
		);
	}
	console.log('   (heavy/light = how many times the fair share; 1.00x = perfect)');
}

function weights(): void {
	const nodes = [node('cache-1'), node('cache-2'), node('cache-3'), node('cache-big', 'az-1', 2)];
	const ring = new HashRing(nodes, 160);
	const load = loadByNode(ring, keys);
	heading('B. one machine twice as big — weight 2 means twice the virtual nodes');
	console.log(
		row([
			['node', 16],
			['weight', 10],
			['got', 12],
			['fair share', 14]
		])
	);
	for (const spec of nodes)
		console.log(
			row([
				[spec.id, 16],
				[spec.weight, 10],
				[pct(load.get(spec.id) ?? 0, KEYS), 12],
				[pct(spec.weight, 5), 14]
			])
		);
}

function replicas(): void {
	const nodes = nodeList('store', 6);
	const ring = new HashRing(nodes, 160);
	const sample = keys.slice(0, 50_000);
	heading('C. 6 nodes, 3 AZs, 3 copies of every key — how to pick the next 3 from the ring');
	console.log(
		row([
			['rule', 30],
			['not 3 distinct nodes', 22],
			['not 3 distinct AZs', 20],
			['one AZ loss kills all copies', 30]
		])
	);
	const rules: [ReplicaRule, string][] = [
		['next-points', 'the next 3 points'],
		['distinct-nodes', 'the next 3 distinct nodes'],
		['distinct-zones', 'the next 3 distinct AZs']
	];
	for (const [rule, label] of rules) {
		let sharedNode = 0;
		let sharedZone = 0;
		let singleZone = 0;
		for (const key of sample) {
			const chosen = ring.replicas(key, 3, rule);
			if (new Set(chosen.map((spec) => spec.id)).size < 3) sharedNode++;
			const zones = new Set(chosen.map((spec) => spec.zone)).size;
			if (zones < 3) sharedZone++;
			if (zones === 1) singleZone++;
		}
		console.log(
			row([
				[label, 30],
				[pct(sharedNode, sample.length), 22],
				[pct(sharedZone, sample.length), 20],
				[pct(singleZone, sample.length), 30]
			])
		);
	}
	console.log(
		`   (${sample.length.toLocaleString('en-US')} keys; the nodes placed in az-1, az-2, az-3 in turn)`
	);
}

balance();
weights();
replicas();
