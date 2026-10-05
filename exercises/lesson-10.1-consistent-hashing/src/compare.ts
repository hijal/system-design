import { hash32 } from './hash';
import {
	HashRing,
	JumpRouter,
	RendezvousRouter,
	type Router,
	loadByNode,
	movedKeys,
	nodeList,
	spread
} from './ring';
import { heading, keyNames, pct, ratio, row, zipfSampler } from './random';

const KEYS = Number(process.env.KEYS ?? 100_000);
const NODES = Number(process.env.NODES ?? 10);
const VNODES = Number(process.env.VNODES ?? 160);
const BATCH = Number(process.env.BATCH ?? 1_000);
const BATCHES = Number(process.env.BATCHES ?? 200);
const ZIPF = Number(process.env.ZIPF ?? 1.1);
const FACTOR = Number(process.env.FACTOR ?? 1.25);
const keys = keyNames('tasks:board', KEYS);

function lookupCost(router: Router): string {
	if (router instanceof HashRing) {
		let steps = 0;
		for (const key of keys.slice(0, 10_000)) {
			router.route(key);
			steps += router.lastSteps;
		}
		return `1 hash + ${(steps / 10_000).toFixed(1)} comparisons`;
	}
	if (router instanceof JumpRouter) {
		let jumps = 0;
		for (const key of keys.slice(0, 10_000)) {
			router.route(key);
			jumps += router.lastJumps;
		}
		return `1 hash + ${(jumps / 10_000).toFixed(1)} jumps`;
	}
	return `${NODES} hash`;
}

function algorithms(): void {
	const nodes = nodeList('cache', NODES);
	const grown = nodeList('cache', NODES + 1);
	const middle = nodes[Math.floor(NODES / 2)]?.id ?? '';
	const shrunk = nodes.filter((spec) => spec.id !== middle);
	const build: ((list: typeof nodes) => Router)[] = [
		(list) => new HashRing(list, VNODES),
		(list) => new RendezvousRouter(list),
		(list) => new JumpRouter(list)
	];
	heading(`A. ${NODES} nodes, ${KEYS.toLocaleString('en-US')} keys — three methods side by side`);
	console.log(
		row([
			['method', 20],
			['heaviest', 13],
			['node added', 12],
			[`${middle} removed`, 13],
			['lookup work', 24],
			['extra memory', 16]
		])
	);
	for (const make of build) {
		const router = make(nodes);
		const { max } = spread(loadByNode(router, keys), nodes);
		const added = movedKeys(router, make(grown), keys).length;
		const removed = movedKeys(router, make(shrunk), keys).length;
		const memory =
			router instanceof HashRing
				? `${router.points.length.toLocaleString('en-US')} points`
				: 'none';
		console.log(
			row([
				[router.label, 20],
				[ratio(max), 13],
				[pct(added, KEYS), 12],
				[pct(removed, KEYS), 13],
				[lookupCost(router), 24],
				[memory, 16]
			])
		);
	}
	console.log(
		`   ideal: on add 1/${NODES + 1} = ${pct(1, NODES + 1)}, removing a middle one 1/${NODES} = ${pct(1, NODES)}`
	);
}

function hotKeys(): void {
	const nodes = nodeList('cache', NODES);
	const ring = new HashRing(nodes, VNODES);
	const capacity = Math.ceil((FACTOR * BATCH) / NODES);
	const sample = zipfSampler(KEYS, ZIPF, 3);
	let plainMaxSum = 0;
	let plainWorst = 0;
	let boundedMaxSum = 0;
	let boundedWorst = 0;
	let displaced = 0;
	let hottestShare = 0;
	for (let b = 0; b < BATCHES; b++) {
		const plain = new Map<string, number>();
		const bounded = new Map<string, number>();
		const counts = new Map<number, number>();
		for (let i = 0; i < BATCH; i++) {
			const rank = sample();
			counts.set(rank, (counts.get(rank) ?? 0) + 1);
			const key = keys[rank] ?? '';
			const home = ring.route(key);
			plain.set(home, (plain.get(home) ?? 0) + 1);
			const start = ring.firstIndexAtOrAfter(hash32(key));
			const seen = new Set<string>();
			for (let step = 0; step < ring.points.length; step++) {
				const candidate = ring.pointAt(start + step).node.id;
				if (seen.has(candidate)) continue;
				seen.add(candidate);
				if ((bounded.get(candidate) ?? 0) < capacity) {
					bounded.set(candidate, (bounded.get(candidate) ?? 0) + 1);
					if (candidate !== home) displaced++;
					break;
				}
			}
		}
		const fair = BATCH / NODES;
		const plainMax = Math.max(...plain.values()) / fair;
		const boundedMax = Math.max(...bounded.values()) / fair;
		plainMaxSum += plainMax;
		boundedMaxSum += boundedMax;
		plainWorst = Math.max(plainWorst, plainMax);
		boundedWorst = Math.max(boundedWorst, boundedMax);
		hottestShare += Math.max(...counts.values()) / BATCH;
	}
	heading(
		`B. Hot key: Zipf ${ZIPF}, ${BATCH.toLocaleString('en-US')} requests at once, ${BATCHES} times — the hottest key alone is ~${pct(hottestShare, BATCHES)} of traffic`
	);
	console.log(
		row([
			['method', 30],
			['heavy (avg)', 12],
			['heavy (worst)', 22],
			['off its own node', 22]
		])
	);
	console.log(
		row([
			[`ring (vnode ${VNODES})`, 30],
			[ratio(plainMaxSum / BATCHES), 12],
			[ratio(plainWorst), 22],
			['0.0%', 22]
		])
	);
	console.log(
		row([
			[`bounded load, c = ${FACTOR}`, 30],
			[ratio(boundedMaxSum / BATCHES), 12],
			[ratio(boundedWorst), 22],
			[pct(displaced, BATCH * BATCHES), 22]
		])
	);
	console.log(
		`   (each node's limit = ceil(${FACTOR} × ${BATCH} / ${NODES}) = ${capacity}; when full, the next node on the ring)`
	);
}

algorithms();
hotKeys();
