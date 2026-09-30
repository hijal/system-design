export type Decision = {
	allowed: boolean;
	remaining: number;
	retryAfterMs: number;
};

export type RateLimiter = {
	readonly name: string;
	check(key: string, now: number): Decision;
	entries(): number;
	reset(): void;
};

export class FixedWindowCounter implements RateLimiter {
	readonly name = 'fixed window';
	readonly #limit: number;
	readonly #windowMs: number;
	#state = new Map<string, { windowStart: number; count: number }>();

	constructor(limit: number, windowMs: number) {
		this.#limit = limit;
		this.#windowMs = windowMs;
	}

	check(key: string, now: number): Decision {
		const windowStart = Math.floor(now / this.#windowMs) * this.#windowMs;
		const current = this.#state.get(key);
		if (!current || current.windowStart !== windowStart) {
			this.#state.set(key, { windowStart, count: 1 });
			return { allowed: true, remaining: this.#limit - 1, retryAfterMs: 0 };
		}
		if (current.count < this.#limit) {
			current.count += 1;
			return { allowed: true, remaining: this.#limit - current.count, retryAfterMs: 0 };
		}
		return {
			allowed: false,
			remaining: 0,
			retryAfterMs: windowStart + this.#windowMs - now
		};
	}

	entries(): number {
		return this.#state.size;
	}

	reset(): void {
		this.#state = new Map();
	}
}

export class SlidingWindowLog implements RateLimiter {
	readonly name = 'sliding log';
	readonly #limit: number;
	readonly #windowMs: number;
	#state = new Map<string, number[]>();

	constructor(limit: number, windowMs: number) {
		this.#limit = limit;
		this.#windowMs = windowMs;
	}

	check(key: string, now: number): Decision {
		const cutoff = now - this.#windowMs;
		const stamps = this.#state.get(key) ?? [];
		let keep = 0;
		while (keep < stamps.length && (stamps[keep] ?? 0) <= cutoff) keep += 1;
		const live = keep > 0 ? stamps.slice(keep) : stamps;
		if (live.length < this.#limit) {
			live.push(now);
			this.#state.set(key, live);
			return { allowed: true, remaining: this.#limit - live.length, retryAfterMs: 0 };
		}
		this.#state.set(key, live);
		const oldest = live[0] ?? now;
		return { allowed: false, remaining: 0, retryAfterMs: oldest + this.#windowMs - now };
	}

	entries(): number {
		return this.#state.size;
	}

	reset(): void {
		this.#state = new Map();
	}
}

export class SlidingWindowCounter implements RateLimiter {
	readonly name = 'sliding counter';
	readonly #limit: number;
	readonly #windowMs: number;
	#state = new Map<string, { windowStart: number; count: number; previous: number }>();

	constructor(limit: number, windowMs: number) {
		this.#limit = limit;
		this.#windowMs = windowMs;
	}

	check(key: string, now: number): Decision {
		const windowStart = Math.floor(now / this.#windowMs) * this.#windowMs;
		let current = this.#state.get(key);
		if (!current) {
			current = { windowStart, count: 0, previous: 0 };
			this.#state.set(key, current);
		}
		if (current.windowStart !== windowStart) {
			const gap = (windowStart - current.windowStart) / this.#windowMs;
			current.previous = gap === 1 ? current.count : 0;
			current.count = 0;
			current.windowStart = windowStart;
		}
		const elapsed = (now - windowStart) / this.#windowMs;
		const estimate = current.previous * (1 - elapsed) + current.count;
		if (estimate < this.#limit) {
			current.count += 1;
			return {
				allowed: true,
				remaining: Math.max(0, Math.floor(this.#limit - estimate - 1)),
				retryAfterMs: 0
			};
		}
		return {
			allowed: false,
			remaining: 0,
			retryAfterMs: windowStart + this.#windowMs - now
		};
	}

	entries(): number {
		return this.#state.size;
	}

	reset(): void {
		this.#state = new Map();
	}
}

export class TokenBucket implements RateLimiter {
	readonly name = 'token bucket';
	readonly #capacity: number;
	readonly #refillPerMs: number;
	#state = new Map<string, { tokens: number; last: number }>();

	constructor(capacity: number, refillPerSecond: number) {
		this.#capacity = capacity;
		this.#refillPerMs = refillPerSecond / 1000;
	}

	check(key: string, now: number): Decision {
		let current = this.#state.get(key);
		if (!current) {
			current = { tokens: this.#capacity, last: now };
			this.#state.set(key, current);
		}
		const gained = (now - current.last) * this.#refillPerMs;
		current.tokens = Math.min(this.#capacity, current.tokens + gained);
		current.last = now;
		if (current.tokens >= 1) {
			current.tokens -= 1;
			return { allowed: true, remaining: Math.floor(current.tokens), retryAfterMs: 0 };
		}
		return {
			allowed: false,
			remaining: 0,
			retryAfterMs: Math.ceil((1 - current.tokens) / this.#refillPerMs)
		};
	}

	entries(): number {
		return this.#state.size;
	}

	reset(): void {
		this.#state = new Map();
	}
}

export class LeakyBucket implements RateLimiter {
	readonly name = 'leaky bucket';
	readonly #capacity: number;
	readonly #leakPerMs: number;
	#state = new Map<string, { level: number; last: number }>();

	constructor(capacity: number, leakPerSecond: number) {
		this.#capacity = capacity;
		this.#leakPerMs = leakPerSecond / 1000;
	}

	check(key: string, now: number): Decision {
		let current = this.#state.get(key);
		if (!current) {
			current = { level: 0, last: now };
			this.#state.set(key, current);
		}
		const leaked = (now - current.last) * this.#leakPerMs;
		current.level = Math.max(0, current.level - leaked);
		current.last = now;
		if (current.level + 1 <= this.#capacity) {
			current.level += 1;
			return {
				allowed: true,
				remaining: Math.floor(this.#capacity - current.level),
				retryAfterMs: 0
			};
		}
		return {
			allowed: false,
			remaining: 0,
			retryAfterMs: Math.ceil((current.level + 1 - this.#capacity) / this.#leakPerMs)
		};
	}

	entries(): number {
		return this.#state.size;
	}

	reset(): void {
		this.#state = new Map();
	}
}
