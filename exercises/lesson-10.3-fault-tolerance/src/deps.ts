export const DEPS = [
	'pg-primary',
	'pg-replica',
	'redis-cache',
	'redis-limiter',
	'redis-queue',
	'billing',
	'flags',
	'object-storage',
	'email'
] as const;

export type Dep = (typeof DEPS)[number];

export type Fault = 'down' | 'slow';

const HEALTHY_MS: Record<Dep, number> = {
	'pg-primary': 4,
	'pg-replica': 3,
	'redis-cache': 1,
	'redis-limiter': 1,
	'redis-queue': 1,
	billing: 20,
	flags: 2,
	'object-storage': 40,
	email: 250
};

export const SLOW_MS = 3_000;
const DOWN_MS = 1;

export class DepError extends Error {
	constructor(
		readonly dep: Dep,
		readonly reason: 'down' | 'timeout'
	) {
		super(`${dep} ${reason}`);
	}
}

export class Ctx {
	elapsed = 0;
	committed = false;
	readonly degraded = new Set<string>();

	constructor(private readonly faults: ReadonlyMap<Dep, Fault>) {}

	call(dep: Dep, timeoutMs = Number.POSITIVE_INFINITY): void {
		const fault = this.faults.get(dep);
		const latency = fault === 'down' ? DOWN_MS : fault === 'slow' ? SLOW_MS : HEALTHY_MS[dep];
		if (latency > timeoutMs) {
			this.elapsed += timeoutMs;
			throw new DepError(dep, 'timeout');
		}
		this.elapsed += latency;
		if (fault === 'down') throw new DepError(dep, 'down');
	}

	commit(): void {
		this.committed = true;
	}

	attempt(work: () => void): boolean {
		try {
			work();
			return true;
		} catch (error) {
			if (error instanceof DepError) return false;
			throw error;
		}
	}

	soft(label: string, work: () => void): void {
		if (!this.attempt(work)) this.degraded.add(label);
	}

	parallel(...branches: ((ctx: Ctx) => void)[]): void {
		let longest = 0;
		let failure: DepError | undefined;
		for (const branch of branches) {
			const child = new Ctx(this.faults);
			try {
				branch(child);
			} catch (error) {
				if (!(error instanceof DepError)) throw error;
				failure ??= error;
			}
			longest = Math.max(longest, child.elapsed);
			for (const label of child.degraded) this.degraded.add(label);
		}
		this.elapsed += longest;
		if (failure) throw failure;
	}
}

export type Outcome =
	| { kind: 'ok'; elapsed: number }
	| { kind: 'degraded'; elapsed: number; missing: string[] }
	| { kind: 'failed'; elapsed: number; cause: DepError; afterCommit: boolean };

export function run(handler: (ctx: Ctx) => void, faults: ReadonlyMap<Dep, Fault>): Outcome {
	const ctx = new Ctx(faults);
	try {
		handler(ctx);
	} catch (error) {
		if (!(error instanceof DepError)) throw error;
		return { kind: 'failed', elapsed: ctx.elapsed, cause: error, afterCommit: ctx.committed };
	}
	if (ctx.degraded.size > 0)
		return { kind: 'degraded', elapsed: ctx.elapsed, missing: [...ctx.degraded] };
	return { kind: 'ok', elapsed: ctx.elapsed };
}
