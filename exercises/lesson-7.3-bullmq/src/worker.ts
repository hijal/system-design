import { Worker, type Job } from 'bullmq';
import { z } from 'zod';
import { assignEmailSchema, connection, QUEUE_NAME } from './config';

// Lesson 7.3 - the worker, the consumer side. A separate process from the API: scaling, deploying or restarting
// the API does nothing to the worker, and vice versa.
//
// When the processor function returns successfully BullMQ moves the job to `completed` - this is Lesson 7.2's ack.
// If it throws: `delayed` (again after the backoff) while `attempts` remain, otherwise `failed`.

const env = z
	.object({
		PROVIDER_URL: z.string().url(),
		CONCURRENCY: z.coerce.number().int().positive().default(8),
		// Production's default is 30 s - can be lowered to keep the scenario short (see the README)
		LOCK_MS: z.coerce.number().int().positive().default(30_000),
		STALLED_MS: z.coerce.number().int().positive().default(30_000),
		SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(5000)
	})
	.parse(process.env);

async function processAssignEmail(job: Job): Promise<void> {
	// data coming from Redis - another process wrote it, so parse it instead of trusting it
	const data = assignEmailSchema.parse(job.data);
	const res = await fetch(`${env.PROVIDER_URL}/send`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		// job.id is sent to the provider as the key - with a real provider this is where the idempotency key goes
		body: JSON.stringify({ key: job.id, to: data.to }),
		// no external call without a timeout (Lesson 7.1)
		signal: AbortSignal.timeout(env.SEND_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`provider responded ${res.status}`);
}

const worker = new Worker(QUEUE_NAME, processAssignEmail, {
	connection,
	concurrency: env.CONCURRENCY,
	lockDuration: env.LOCK_MS,
	stalledInterval: env.STALLED_MS
});

worker.on('error', (error) => console.error('worker error:', error.message));

// Graceful shutdown (Lesson 3.4): stop taking new jobs, wait for the running jobs to finish, then exit.
// With SIGKILL none of this happens - then once the lock of a running job expires it comes back as "stalled".
async function shutdown(signal: string): Promise<void> {
	console.log(`worker ${process.pid}: ${signal} - finishing the running jobs, then shutting down`);
	await worker.close();
	process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void worker.waitUntilReady().then(() => process.send?.({ ready: true, port: 0 }));
