import { HashRing, ModuloRouter, type Router, nodeList } from './ring';
import { heading, keyNames, pct, row, zipfSampler } from './random';

const KEYS = Number(process.env.KEYS ?? 50_000);
const REQUESTS = Number(process.env.REQUESTS ?? 200_000);
const RPS = Number(process.env.RPS ?? 5_000);
const ZIPF = Number(process.env.ZIPF ?? 0.9);
const VNODES = Number(process.env.VNODES ?? 160);
const keys = keyNames('tasks:board', KEYS);

type Entry = { version: number };
type Cluster = Map<string, Map<string, Entry>>;

function warm(
	router: Router,
	nodeIds: readonly string[],
	database: ReadonlyMap<string, number>
): Cluster {
	const cluster: Cluster = new Map(nodeIds.map((id) => [id, new Map<string, Entry>()]));
	for (const key of keys)
		cluster.get(router.route(key))?.set(key, { version: database.get(key) ?? 0 });
	return cluster;
}

function read(
	cluster: Cluster,
	router: Router,
	key: string,
	database: ReadonlyMap<string, number>
): 'hit' | 'miss' | 'stale' {
	const store = cluster.get(router.route(key));
	if (!store) throw new Error('unknown node');
	const current = database.get(key) ?? 0;
	const cached = store.get(key);
	if (cached === undefined) {
		store.set(key, { version: current });
		return 'miss';
	}
	return cached.version === current ? 'hit' : 'stale';
}

function scaleOut(): void {
	const before = nodeList('cache', 3);
	const after = nodeList('cache', 4);
	const database = new Map(keys.map((key) => [key, 0]));
	heading(
		`A. TaskFlow's cache: 3 nodes to 4, while warm - ${RPS.toLocaleString('en-US')} reads/s, Zipf ${ZIPF}`
	);
	console.log(
		row([
			['routing', 22],
			['first 1 s hit', 16],
			['DB in first 1 s', 17],
			['first 10 s hit', 17],
			['total DB queries', 18]
		])
	);
	const routers: [Router, Router][] = [
		[new ModuloRouter(before), new ModuloRouter(after)],
		[new HashRing(before, VNODES), new HashRing(after, VNODES)]
	];
	for (const [old, next] of routers) {
		const cluster = warm(
			old,
			[...before, ...after].map((spec) => spec.id),
			database
		);
		const sample = zipfSampler(KEYS, ZIPF, 7);
		let firstSecondHits = 0;
		let firstTenHits = 0;
		let misses = 0;
		for (let i = 0; i < REQUESTS; i++) {
			const outcome = read(cluster, next, keys[sample()] ?? '', database);
			if (outcome === 'miss') misses++;
			else if (i < RPS) firstSecondHits++;
			if (outcome !== 'miss' && i < RPS * 10) firstTenHits++;
		}
		console.log(
			row([
				[next.label, 22],
				[pct(firstSecondHits, RPS), 16],
				[(RPS - firstSecondHits).toLocaleString('en-US'), 17],
				[pct(firstTenHits, Math.min(REQUESTS, RPS * 10)), 17],
				[misses.toLocaleString('en-US'), 18]
			])
		);
	}
	console.log(
		'   (hit rate ~100% before the change - every key was warm; so every miss is caused only by the routing change)'
	);
}

function flappingNode(flushOnRejoin: boolean): {
	stale: number;
	staleKeys: number;
	missesAfter: number;
} {
	const nodes = nodeList('cache', 4);
	const flapping = nodes[1]?.id ?? '';
	const full = new HashRing(nodes, VNODES);
	const degraded = new HashRing(
		nodes.filter((spec) => spec.id !== flapping),
		VNODES
	);
	const database = new Map(keys.map((key) => [key, 0]));
	const cluster = warm(
		full,
		nodes.map((spec) => spec.id),
		database
	);
	const sample = zipfSampler(KEYS, ZIPF, 11);
	for (let i = 0; i < RPS * 30; i++) {
		const key = keys[sample()] ?? '';
		if (i % 50 === 0) {
			database.set(key, (database.get(key) ?? 0) + 1);
			cluster.get(degraded.route(key))?.delete(key);
		} else read(cluster, degraded, key, database);
	}
	if (flushOnRejoin) cluster.get(flapping)?.clear();
	const staleKeys = new Set<string>();
	let stale = 0;
	let missesAfter = 0;
	for (let i = 0; i < RPS * 10; i++) {
		const key = keys[sample()] ?? '';
		const outcome = read(cluster, full, key, database);
		if (outcome === 'stale') {
			stale++;
			staleKeys.add(key);
		}
		if (outcome === 'miss') missesAfter++;
	}
	return { stale, staleKeys: staleKeys.size, missesAfter };
}

function flapping(): void {
	heading('B. cache-2 out of reach for 30 s (not dead), then came back - with its old data');
	console.log(
		row([
			['on return', 28],
			['stale read (10 s)', 19],
			['distinct stale keys', 20],
			['miss (10 s)', 13]
		])
	);
	const cases: [string, boolean][] = [
		['put back on the ring as is', false],
		['flush first, then put back', true]
	];
	for (const [label, flush] of cases) {
		const { stale, staleKeys, missesAfter } = flappingNode(flush);
		console.log(
			row([
				[label, 28],
				[stale.toLocaleString('en-US'), 19],
				[staleKeys.toLocaleString('en-US'), 20],
				[missesAfter.toLocaleString('en-US'), 13]
			])
		);
	}
	console.log(
		'   (while it is away, one write every 50 requests - the DB changes, and the invalidate goes to the owner at that time)'
	);
}

scaleOut();
flapping();
