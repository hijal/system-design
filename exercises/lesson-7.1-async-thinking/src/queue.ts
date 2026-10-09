// Lesson 7.1 §1.5 - the smallest job queue: an array, and a fixed number of workers.
//
// Deliberately in-memory - today's question is "what changes when work moves off the request path", not
// "how to make a queue durable". You will see this queue's big weakness (every job is lost when the process dies)
// yourself in the README experiment; a durable queue (BullMQ, kept in Redis) is in Lesson 7.3.

export interface QueueStats {
	waiting: number;
	active: number;
	completed: number;
	failed: number;
	peakWaiting: number;
}

export class JobQueue<T> {
	readonly #jobs: T[] = [];
	#active = 0;
	#completed = 0;
	#failed = 0;
	#peakWaiting = 0;

	constructor(
		readonly concurrency: number,
		private readonly handler: (data: T) => Promise<void>
	) {}

	// The producer side: only writing it down - not doing the work. So always instant.
	add(data: T): void {
		this.#jobs.push(data);
		this.#peakWaiting = Math.max(this.#peakWaiting, this.#jobs.length);
		this.#pump();
	}

	stats(): QueueStats {
		return {
			waiting: this.#jobs.length,
			active: this.#active,
			completed: this.#completed,
			failed: this.#failed,
			peakWaiting: this.#peakWaiting
		};
	}

	// The consumer side: never more than `concurrency` jobs at once - however slow the downstream is
	#pump(): void {
		while (this.#active < this.concurrency) {
			const job = this.#jobs.shift();
			if (job === undefined) return;
			this.#active++;
			this.handler(job)
				.then(() => {
					this.#completed++;
				})
				.catch(() => {
					// retry, backoff, DLQ - the topic of Lesson 7.4; here they are only counted
					this.#failed++;
				})
				.finally(() => {
					this.#active--;
					this.#pump();
				});
		}
	}
}
