// Lesson 7.1 §১.৩ — Sequelize এর connection pool এর একটা ছোট নকল (Lesson 5.6 এর `pool` option)।
//
// আসল Postgres নেই — "query" মানে শুধু কিছুক্ষণ অপেক্ষা। কিন্তু আজকের lesson এর জন্য যা দরকার,
// সেটা হুবহু আছে: সর্বোচ্চ `max` টা connection, সব ব্যস্ত হলে লাইন, আর `acquireTimeoutMs` পরে
// error (Sequelize এর `ConnectionAcquireTimeoutError` এর মতো)।

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
				// লাইনে কেউ থাকলে connection সরাসরি তার হাতে — busy সংখ্যা একই থাকে
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
