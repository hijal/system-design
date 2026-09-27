// Lesson 7.1 §১.৫ — সবচেয়ে ছোট job queue: একটা array, আর নির্দিষ্ট সংখ্যক worker।
//
// ইচ্ছা করে in-memory — আজকের প্রশ্ন "request এর পথ থেকে কাজ সরালে কী বদলায়", "queue কীভাবে
// টেকসই করব" না। এই queue এর বড় দুর্বলতা (process মরলে সব job হারায়) README এর experiment এ
// নিজে দেখবে; টেকসই queue (Redis এ রাখা BullMQ) Lesson 7.3 এ।

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

	// Producer এর দিক: শুধু খাতায় লেখা — কাজ করা না। তাই সবসময় তাৎক্ষণিক।
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

	// Consumer এর দিক: একসাথে `concurrency` টার বেশি কাজ কখনো না — downstream যত ধীরই হোক
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
					// retry, backoff, DLQ — Lesson 7.4 এর বিষয়; এখানে শুধু গুনে রাখা
					this.#failed++;
				})
				.finally(() => {
					this.#active--;
					this.#pump();
				});
		}
	}
}
