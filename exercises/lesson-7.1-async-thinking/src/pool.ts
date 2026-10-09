// Lesson 7.1 §1.3 - a small imitation of Sequelize's connection pool (the `pool` option from Lesson 5.6).
//
// No real Postgres - a "query" just means waiting a while. But what today's lesson needs
// is exactly there: at most `max` connections, a queue when all are busy, and an error after `acquireTimeoutMs`
// (like Sequelize's `ConnectionAcquireTimeoutError`).

export class AcquireTimeoutError extends Error {
	override readonly name = 'AcquireTimeoutError';
}

export interface Connection {
	query(durationMs: number): Promise<void>;
	release(): void;
}

type Waiter = { grant: (connection: Connection) => void; timer: NodeJS.Timeout };

export interface PoolStats {
	max: number;
	busy: number;
	waiting: number;
	acquireTimeouts: number;
}

export class Pool {
	#busy = 0;
	#acquireTimeouts = 0;
	readonly #waiters: Waiter[] = [];

	constructor(
		readonly max: number,
		readonly acquireTimeoutMs: number
	) {}

	acquire(): Promise<Connection> {
		if (this.#busy < this.max) {
			this.#busy++;
			return Promise.resolve(this.#connection());
		}
		return new Promise<Connection>((resolve, reject) => {
			const waiter: Waiter = {
				grant: resolve,
				timer: setTimeout(() => {
					const index = this.#waiters.indexOf(waiter);
					if (index !== -1) this.#waiters.splice(index, 1);
					this.#acquireTimeouts++;
					reject(new AcquireTimeoutError(`no connection within ${this.acquireTimeoutMs} ms`));
				}, this.acquireTimeoutMs)
			};
			this.#waiters.push(waiter);
		});
	}

	stats(): PoolStats {
		return {
			max: this.max,
			busy: this.#busy,
			waiting: this.#waiters.length,
			acquireTimeouts: this.#acquireTimeouts
		};
	}

	#connection(): Connection {
		let released = false;
		return {
			query: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
			release: () => {
				if (released) return;
				released = true;
				// if someone is waiting, the connection goes straight to them - the busy count stays the same
				const next = this.#waiters.shift();
				if (next) {
					clearTimeout(next.timer);
					next.grant(this.#connection());
				} else {
					this.#busy--;
				}
			}
		};
	}
}
