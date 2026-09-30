export type BreakerState = 'closed' | 'open' | 'half-open';

export type BreakerOptions = {
	failureThreshold: number;
	openMs: number;
	successesToClose: number;
};

export type BreakerStats = {
	rejected: number;
	opened: number;
	closed: number;
	probes: number;
};

export class CircuitBreaker {
	#state: BreakerState = 'closed';
	#failures = 0;
	#successes = 0;
	#openedAt = 0;
	#probeInFlight = false;
	readonly #options: BreakerOptions;
	readonly #stats: BreakerStats = { rejected: 0, opened: 0, closed: 0, probes: 0 };

	constructor(options: BreakerOptions) {
		this.#options = options;
	}

	state(now: number): BreakerState {
		if (this.#state === 'open' && now - this.#openedAt >= this.#options.openMs)
			this.#state = 'half-open';
		return this.#state;
	}

	allow(now: number): boolean {
		const state = this.state(now);
		if (state === 'closed') return true;
		if (state === 'open') {
			this.#stats.rejected += 1;
			return false;
		}
		if (this.#probeInFlight) {
			this.#stats.rejected += 1;
			return false;
		}
		this.#probeInFlight = true;
		this.#stats.probes += 1;
		return true;
	}

	onSuccess(): void {
		if (this.#state === 'half-open') {
			this.#probeInFlight = false;
			this.#successes += 1;
			if (this.#successes >= this.#options.successesToClose) {
				this.#state = 'closed';
				this.#failures = 0;
				this.#successes = 0;
				this.#stats.closed += 1;
			}
			return;
		}
		this.#failures = 0;
	}

	onFailure(now: number): void {
		if (this.#state === 'half-open') {
			this.#probeInFlight = false;
			this.#successes = 0;
			this.#state = 'open';
			this.#openedAt = now;
			this.#stats.opened += 1;
			return;
		}
		if (this.#state === 'open') return;
		this.#failures += 1;
		if (this.#failures >= this.#options.failureThreshold) {
			this.#state = 'open';
			this.#openedAt = now;
			this.#failures = 0;
			this.#stats.opened += 1;
		}
	}

	stats(): BreakerStats {
		return { ...this.#stats };
	}
}
