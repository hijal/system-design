import type { ConnectionOptions, JobsOptions } from 'bullmq';
import { z } from 'zod';

// API (producer), worker আর scenario — তিনজনের ভাগ করা জিনিস: Redis এর ঠিকানা, queue এর নাম,
// আর job এর data এর আকৃতি।

export const QUEUE_NAME = 'emails';

const env = z
	.object({
		REDIS_HOST: z.string().default('127.0.0.1'),
		REDIS_PORT: z.coerce.number().int().positive().default(6381)
	})
	.parse(process.env);

// Worker এর blocking connection এ `maxRetriesPerRequest: null` লাগে — নইলে Redis কিছুক্ষণ না
// পাওয়া গেলে ioredis command ব্যর্থ করে দেয়, আর worker থেমে যায়। (BullMQ নিজেও এটা বসায় আর সতর্ক করে।)
export const redisAddress = { host: env.REDIS_HOST, port: env.REDIS_PORT };
export const connection: ConnectionOptions = { ...redisAddress, maxRetriesPerRequest: null };

// Job এর data Redis এ JSON হয়ে থাকে, আর worker অন্য process — তাই worker এ এটা runtime input,
// `as` দিয়ে বিশ্বাস না করে Zod দিয়ে parse করা হয়।
export const assignEmailSchema = z.object({
	taskId: z.number().int().positive(),
	assigneeId: z.number().int().positive(),
	to: z.string().email()
});
export type AssignEmail = z.infer<typeof assignEmailSchema>;

// Job এর নাম আর data একসাথে — এই queue তে এখন একটাই ধরনের job, পরে আরও আসবে
export const JOB_ASSIGN_EMAIL = 'assign-email';

export function assignJobOptions(attempts: number): JobsOptions {
	return {
		attempts,
		// 1 s, 2 s, 4 s, 8 s … (2^(চেষ্টা−1) × delay) — আর ±50% jitter, যাতে একসাথে ব্যর্থ হওয়া
		// job গুলো একসাথে আবার ঝাঁপিয়ে না পড়ে (Lesson 7.4 এ বিস্তারিত)
		backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
		// শেষ হওয়া job চিরকাল Redis এ রাখলে memory ভরবে — এক ঘণ্টা বা শেষ ১০ হাজার
		removeOnComplete: { age: 3600, count: 10_000 },
		// ব্যর্থ job বেশিদিন — এগুলো দেখে কেউ সিদ্ধান্ত নেবে
		removeOnFail: { age: 7 * 24 * 3600 }
	};
}

// Job ID আমরা নিজে বানাই, data থেকে: একই assign দুবার এলে (double click, client এর retry)
// একই ID — আর BullMQ একই ID এর দ্বিতীয় job যোগ করে না। (Custom ID তে ':' চলে না।)
export function assignJobId(job: AssignEmail): string {
	return `assign-${job.taskId}-${job.assigneeId}`;
}
