import { HashRing, type ReplicaRule, loadByNode, node, nodeList, spread } from './ring';
import { hash32 } from './hash';
import { heading, keyNames, pct, ratio, row } from './random';

const KEYS = Number(process.env.KEYS ?? 200_000);
const NODES = Number(process.env.NODES ?? 10);
const keys = keyNames('tasks:board', KEYS);

function balance(): void {
	const nodes = nodeList('cache', NODES);
	heading(
		`ক. ${NODES}টা node, ${KEYS.toLocaleString('en-US')}টা key — virtual node বাড়ালে ভাগ কতটা সমান হয়`
	);
	console.log(
		row([
			['vnode / node', 16],
			['সবচেয়ে ভারী', 14],
			['সবচেয়ে হালকা', 15],
			['ring এ বিন্দু', 15],
			['lookup এ ধাপ', 15]
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
	console.log('   (ভারী/হালকা = ন্যায্য ভাগের কত গুণ; 1.00x = নিখুঁত)');
}

function weights(): void {
	const nodes = [node('cache-1'), node('cache-2'), node('cache-3'), node('cache-big', 'az-1', 2)];
	const ring = new HashRing(nodes, 160);
	const load = loadByNode(ring, keys);
	heading('খ. একটা machine দ্বিগুণ বড় — weight 2 মানে দ্বিগুণ virtual node');
	console.log(
		row([
			['node', 16],
			['weight', 10],
			['পেল', 12],
			['ন্যায্য ভাগ', 14]
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
	heading('গ. ৬টা node, ৩টা AZ, প্রতিটা key এর ৩টা copy — ring থেকে পরের ৩টা কীভাবে বাছবে');
	console.log(
		row([
			['নিয়ম', 30],
			['৩টা আলাদা node না', 20],
			['৩টা আলাদা AZ না', 18],
			['এক AZ গেলেই সব copy শেষ', 26]
		])
	);
	const rules: [ReplicaRule, string][] = [
		['next-points', 'পরের ৩টা বিন্দু'],
		['distinct-nodes', 'পরের ৩টা আলাদা node'],
		['distinct-zones', 'পরের ৩টা আলাদা AZ']
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
				[pct(sharedNode, sample.length), 20],
				[pct(sharedZone, sample.length), 18],
				[pct(singleZone, sample.length), 26]
			])
		);
	}
	console.log(
		`   (${sample.length.toLocaleString('en-US')}টা key; node গুলো az-1, az-2, az-3 তে পালা করে বসানো)`
	);
}

balance();
weights();
replicas();
