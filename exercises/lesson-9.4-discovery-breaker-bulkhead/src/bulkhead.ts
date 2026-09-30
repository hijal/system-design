export type BulkheadResult<T> =
	{ admitted: true; value: T; waitedMs: number } | { admitted: false; waitedMs: number };

export class Bulkhead {
	#inUse = 0;
	#peak = 0;
	#queued = 0;
	#rejected = 0;
	readonly #limit: number;
	readonly #queueLimit: number;
	readonly #waiting: Array<() => void> = [];

	constructor(limit: number, queueLimit: number) {
		this.#limit = limit;
		this.#queueLimit = queueLimit;
	}

	async run<T>(task: () => Promise<T>): Promise<BulkheadResult<T>> {
		const started = performance.now();
		if (this.#inUse >= this.#limit && this.#waiting.length >= this.#queueLimit) {
			this.#rejected += 1;
			return { admitted: false, waitedMs: performance.now() - started };
		}
		if (this.#inUse >= this.#limit) {
			this.#queued += 1;
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		}
		this.#inUse += 1;
		if (this.#inUse > this.#peak) this.#peak = this.#inUse;
		const waitedMs = performance.now() - started;
		try {
			const value = await task();
			return { admitted: true, value, waitedMs };
		} finally {
			this.#inUse -= 1;
			const next = this.#waiting.shift();
			if (next) next();
		}
	}

	inUse(): number {
		return this.#inUse;
	}

	peak(): number {
		return this.#peak;
	}

	queued(): number {
		return this.#queued;
	}

	rejected(): number {
		return this.#rejected;
	}
}
