import { hash32, hash64 } from './hash';

export interface NodeSpec {
	id: string;
	weight: number;
	zone: string;
}

export type ReplicaRule = 'next-points' | 'distinct-nodes' | 'distinct-zones';

type RingPoint = { point: number; node: NodeSpec };

export const node = (id: string, zone = 'az-1', weight = 1): NodeSpec => ({ id, weight, zone });

export const nodeList = (prefix: string, count: number): NodeSpec[] =>
	Array.from({ length: count }, (_, i) => node(`${prefix}-${i + 1}`, `az-${(i % 3) + 1}`));

export interface Router {
	readonly label: string;
	route(key: string): string;
}

export class HashRing implements Router {
	readonly label: string;
	readonly points: readonly RingPoint[];
	lastSteps = 0;

	constructor(
		readonly nodes: readonly NodeSpec[],
		readonly virtualNodes: number
	) {
		this.label = `ring (vnode ${virtualNodes})`;
		const points: RingPoint[] = [];
		for (const spec of nodes)
			for (let v = 0; v < Math.round(virtualNodes * spec.weight); v++)
				points.push({ point: hash32(`${spec.id}#${v}`), node: spec });
		this.points = points.sort((a, b) => a.point - b.point);
	}

	firstIndexAtOrAfter(hash: number): number {
		let lo = 0;
		let hi = this.points.length;
		let steps = 0;
		while (lo < hi) {
			steps++;
			const mid = (lo + hi) >>> 1;
			if ((this.points[mid]?.point ?? 0) < hash) lo = mid + 1;
			else hi = mid;
		}
		this.lastSteps = steps;
		return lo === this.points.length ? 0 : lo;
	}

	route(key: string): string {
		return this.pointAt(this.firstIndexAtOrAfter(hash32(key))).node.id;
	}

	pointAt(index: number): RingPoint {
		const point = this.points[index % this.points.length];
		if (!point) throw new Error('empty ring');
		return point;
	}

	replicas(key: string, count: number, rule: ReplicaRule): NodeSpec[] {
		const chosen: NodeSpec[] = [];
		const start = this.firstIndexAtOrAfter(hash32(key));
		const zones = new Set(this.nodes.map((spec) => spec.zone)).size;
		for (let i = 0; i < this.points.length && chosen.length < count; i++) {
			const candidate = this.pointAt(start + i).node;
			const sameNode = chosen.some((spec) => spec.id === candidate.id);
			const sameZone = chosen.some((spec) => spec.zone === candidate.zone);
			if (rule === 'next-points') chosen.push(candidate);
			else if (sameNode) continue;
			else if (rule === 'distinct-zones' && sameZone && chosen.length < zones) continue;
			else chosen.push(candidate);
		}
		return chosen;
	}
}

export class ModuloRouter implements Router {
	readonly label = 'hash % N';
	constructor(readonly nodes: readonly NodeSpec[]) {}

	route(key: string): string {
		const spec = this.nodes[hash32(key) % this.nodes.length];
		if (!spec) throw new Error('no nodes');
		return spec.id;
	}
}

export class RendezvousRouter implements Router {
	readonly label = 'rendezvous (HRW)';
	constructor(readonly nodes: readonly NodeSpec[]) {}

	route(key: string): string {
		let best = '';
		let bestScore = -1;
		for (const spec of this.nodes) {
			const score = hash32(`${spec.id}|${key}`);
			if (score > bestScore) {
				bestScore = score;
				best = spec.id;
			}
		}
		return best;
	}
}

const MASK_64 = (1n << 64n) - 1n;

export function jumpBucket(key: bigint, buckets: number): { bucket: number; jumps: number } {
	let state = key;
	let bucket = -1;
	let next = 0;
	let jumps = 0;
	while (next < buckets) {
		bucket = next;
		jumps++;
		state = (state * 2862933555777941757n + 1n) & MASK_64;
		next = Math.floor(((bucket + 1) * 2 ** 31) / Number((state >> 33n) + 1n));
	}
	return { bucket, jumps };
}

export class JumpRouter implements Router {
	readonly label = 'jump hash';
	lastJumps = 0;
	constructor(readonly nodes: readonly NodeSpec[]) {}

	route(key: string): string {
		const { bucket, jumps } = jumpBucket(hash64(key), this.nodes.length);
		this.lastJumps = jumps;
		const spec = this.nodes[bucket];
		if (!spec) throw new Error('no nodes');
		return spec.id;
	}
}

export function loadByNode(router: Router, keys: readonly string[]): Map<string, number> {
	const load = new Map<string, number>();
	for (const key of keys) {
		const owner = router.route(key);
		load.set(owner, (load.get(owner) ?? 0) + 1);
	}
	return load;
}

export function spread(
	load: ReadonlyMap<string, number>,
	nodes: readonly NodeSpec[]
): { max: number; min: number } {
	const total = [...load.values()].reduce((sum, value) => sum + value, 0);
	const totalWeight = nodes.reduce((sum, spec) => sum + spec.weight, 0);
	let max = 0;
	let min = Number.POSITIVE_INFINITY;
	for (const spec of nodes) {
		const fair = (total * spec.weight) / totalWeight;
		const relative = (load.get(spec.id) ?? 0) / fair;
		max = Math.max(max, relative);
		min = Math.min(min, relative);
	}
	return { max, min };
}

export function movedKeys(before: Router, after: Router, keys: readonly string[]): string[] {
	return keys.filter((key) => before.route(key) !== after.route(key));
}
