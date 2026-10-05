import type { ConnectionOptions, JobsOptions } from 'bullmq';
import { z } from 'zod';

// Shared by the API (producer), the worker and the scenario: Redis's address, the queue's name,
// and the shape of a job's data.

export const QUEUE_NAME = 'emails';

const env = z
	.object({
		REDIS_HOST: z.string().default('127.0.0.1'),
		REDIS_PORT: z.coerce.number().int().positive().default(6381)
	})
	.parse(process.env);

// The worker's blocking connection needs `maxRetriesPerRequest: null` — otherwise when Redis is unreachable
// for a while ioredis fails the command, and the worker stops. (BullMQ sets this itself too, and warns.)
export const redisAddress = { host: env.REDIS_HOST, port: env.REDIS_PORT };
export const connection: ConnectionOptions = { ...redisAddress, maxRetriesPerRequest: null };

// A job's data sits in Redis as JSON, and the worker is another process — so in the worker it is runtime input,
// parsed with Zod rather than trusted with `as`.
export const assignEmailSchema = z.object({
	taskId: z.number().int().positive(),
	assigneeId: z.number().int().positive(),
	to: z.string().email()
});
export type AssignEmail = z.infer<typeof assignEmailSchema>;

// The job's name and data together — there is only one kind of job in this queue now, more will come later
export const JOB_ASSIGN_EMAIL = 'assign-email';

export function assignJobOptions(attempts: number): JobsOptions {
	return {
		attempts,
		// 1 s, 2 s, 4 s, 8 s … (2^(attempt−1) × delay) — and ±50% jitter, so jobs that failed together
		// don't all rush back together (in detail in Lesson 7.4)
		backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
		// keeping finished jobs in Redis forever will fill memory — an hour or the last 10,000
		removeOnComplete: { age: 3600, count: 10_000 },
		// failed jobs for longer — someone will look at them and decide
		removeOnFail: { age: 7 * 24 * 3600 }
	};
}

// We build the job ID ourselves, from the data: if the same assign arrives twice (double click, a client retry)
// it gets the same ID — and BullMQ doesn't add a second job with the same ID. (':' doesn't work in a custom ID.)
export function assignJobId(job: AssignEmail): string {
	return `assign-${job.taskId}-${job.assigneeId}`;
}
