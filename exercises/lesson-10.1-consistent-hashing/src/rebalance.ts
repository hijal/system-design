import {
	HashRing,
	ModuloRouter,
	type Router,
	loadByNode,
	movedKeys,
	nodeList,
	spread
} from './ring';
import { heading, keyNames, pct, ratio, row } from './random';

const KEYS = Number(process.env.KEYS ?? 100_000);
const VNODES = Number(process.env.VNODES ?? 160);
const keys = keyNames('tasks:board', KEYS);

function addNode(): void {
	const before = nodeList('cache', 4);
	const after = nodeList('cache', 5);
	const newcomer = after[4]?.id ?? '';
	heading(
		`A. 4 cache nodes to 5 — how many of ${KEYS.toLocaleString('en-US')} keys move, and where they go`
	);
	console.log(
		row([
			['routing', 26],
			['moved', 10],
			['to the new node', 17],
			['among the old', 17]
		])
	);
	const pairs: [Router, Router][] = [
		[new ModuloRouter(before), new ModuloRouter(after)],
		[new HashRing(before, 1), new HashRing(after, 1)],
		[new HashRing(before, VNODES), new HashRing(after, VNODES)]
	];
	for (const [old, next] of pairs) {
		const moved = movedKeys(old, next, keys);
		const toNewcomer = moved.filter((key) => next.route(key) === newcomer).length;
		console.log(
			row([
				[old.label, 26],
				[pct(moved.length, KEYS), 10],
				[pct(toNewcomer, moved.length), 17],
				[pct(moved.length - toNewcomer, moved.length), 17]
			])
		);
	}
	console.log(`   ideal: only the new node's share = 1/5 = 20.0%, and all of it to the new node`);
}

function removeNode(): void {
	const before = nodeList('cache', 5);
	const lost = before[2]?.id ?? '';
	const after = before.filter((spec) => spec.id !== lost);
	heading(`B. ${lost} died — who took its keys, and how much load is on the heaviest node`);
	console.log(
		row([
			['routing', 26],
			...after.map((spec): [string, number] => [spec.id, 10]),
			['heaviest', 14]
		])
	);
	for (const vnodes of [1, VNODES]) {
		const old = new HashRing(before, vnodes);
		const next = new HashRing(after, vnodes);
		const orphans = keys.filter((key) => old.route(key) === lost);
		const absorbed = loadByNode(next, orphans);
		const { max } = spread(loadByNode(next, keys), after);
		console.log(
			row([
				[old.label, 26],
				...after.map((spec): [string, number] => [
					pct(absorbed.get(spec.id) ?? 0, orphans.length, 0),
					10
				]),
				[ratio(max), 14]
			])
		);
	}
	console.log(
		'   (columns = what share of the dead node\'s keys each one took; "heaviest" = how many times its fair share)'
	);
}

addNode();
removeNode();
