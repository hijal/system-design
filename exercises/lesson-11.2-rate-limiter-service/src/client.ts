import { CheckResult, LeaseResult, type Rule, ruleFor } from './limiter-service';
import { TokenBucket } from './sim';

export type Decision =
	| { kind: 'allow'; remaining: number; source: 'limiter' | 'lease' | 'fallback' | 'fail-open' }
	| { kind: 'deny'; retryAfterMs: number; source: 'limiter' | 'lease' | 'fallback' }
	| { kind: 'unavailable'; retryAfterMs: number };

export interface ClientOptions {
	baseUrl: string;
	rules: readonly Rule[];
	servers: number;
	timeoutMs: number;
	breakerFailures: number;
	breakerOpenMs: number;
	leaseSize?: number;
	fallbackSlack?: number;
}

interface LocalLease {
	tokens: number;
	expires: number;
	denyUntil: number;
}

export class LimiterClient {
	networkCalls = 0;
	failures = 0;
	private consecutive = 0;
	private openUntil = 0;
	private readonly fallback = new Map<string, TokenBucket>();
	private readonly leases = new Map<string, LocalLease>();

	constructor(private readonly options: ClientOptions) {}

	private async post(path: string, body: unknown): Promise<unknown> {
		if (Date.now() < this.openUntil) throw new Error('breaker open');
		this.networkCalls++;
		try {
			const res = await fetch(`${this.options.baseUrl}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.options.timeoutMs)
			});
			if (!res.ok) throw new Error(`limiter ${res.status}`);
			const json: unknown = await res.json();
			this.consecutive = 0;
			return json;
		} catch (error: unknown) {
			this.failures++;
			this.consecutive++;
			if (this.consecutive >= this.options.breakerFailures) {
				this.openUntil = Date.now() + this.options.breakerOpenMs;
				this.consecutive = 0;
			}
			throw error;
		}
	}

	private degrade(key: string, rule: Rule): Decision {
		if (rule.failMode === 'open') return { kind: 'allow', remaining: 0, source: 'fail-open' };
		if (rule.failMode === 'closed') return { kind: 'unavailable', retryAfterMs: 1_000 };
		let bucket = this.fallback.get(key);
		if (bucket === undefined) {
			const share = ((this.options.fallbackSlack ?? 1) * rule.rate) / this.options.servers;
			bucket = new TokenBucket(
				share,
				Math.max(1, ((this.options.fallbackSlack ?? 1) * rule.burst) / this.options.servers),
				Date.now()
			);
			this.fallback.set(key, bucket);
		}
		const now = Date.now();
		return bucket.take(now) === 1
			? { kind: 'allow', remaining: Math.floor(bucket.peek(now)), source: 'fallback' }
			: { kind: 'deny', retryAfterMs: bucket.retryAfterMs(now), source: 'fallback' };
	}

	async check(key: string): Promise<Decision> {
		const rule = ruleFor(this.options.rules, key);
		if (rule === undefined) return { kind: 'allow', remaining: 0, source: 'fail-open' };
		if (this.options.leaseSize !== undefined)
			return this.checkWithLease(key, rule, this.options.leaseSize);
		try {
			const result = CheckResult.parse(await this.post('/v1/check', { key }));
			return result.allowed
				? { kind: 'allow', remaining: result.remaining, source: 'limiter' }
				: { kind: 'deny', retryAfterMs: result.retryAfterMs, source: 'limiter' };
		} catch {
			return this.degrade(key, rule);
		}
	}

	private async checkWithLease(key: string, rule: Rule, size: number): Promise<Decision> {
		const now = Date.now();
		const lease = this.leases.get(key) ?? { tokens: 0, expires: 0, denyUntil: 0 };
		this.leases.set(key, lease);
		if (now >= lease.expires) lease.tokens = 0;
		if (lease.tokens >= 1) {
			lease.tokens--;
			return { kind: 'allow', remaining: lease.tokens, source: 'lease' };
		}
		if (now < lease.denyUntil)
			return { kind: 'deny', retryAfterMs: lease.denyUntil - now, source: 'lease' };
		try {
			const result = LeaseResult.parse(await this.post('/v1/lease', { key, want: size }));
			if (result.granted === 0) {
				lease.denyUntil = Date.now() + result.retryAfterMs;
				return { kind: 'deny', retryAfterMs: result.retryAfterMs, source: 'lease' };
			}
			lease.tokens = result.granted - 1;
			lease.expires = Date.now() + result.ttlMs;
			return { kind: 'allow', remaining: lease.tokens, source: 'lease' };
		} catch {
			return this.degrade(key, rule);
		}
	}
}
