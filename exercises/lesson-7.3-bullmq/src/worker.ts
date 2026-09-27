import { Worker, type Job } from 'bullmq';
import { z } from 'zod';
import { assignEmailSchema, connection, QUEUE_NAME } from './config';

// Lesson 7.3 — worker, consumer এর দিক। API থেকে আলাদা process: API কে scale, deploy বা restart
// করলে worker এর কিছু হয় না, আর উল্টোটাও।
//
// Processor function সফলভাবে ফিরলে BullMQ job কে `completed` এ সরায় — এটাই Lesson 7.2 এর ack।
// Error throw করলে `attempts` বাকি থাকলে `delayed` (backoff এর পরে আবার), নইলে `failed`।

const env = z
	.object({
		PROVIDER_URL: z.string().url(),
		CONCURRENCY: z.coerce.number().int().positive().default(8),
		// Production এর default 30 s — scenario ছোট রাখতে কমানো যায় (README দেখো)
		LOCK_MS: z.coerce.number().int().positive().default(30_000),
		STALLED_MS: z.coerce.number().int().positive().default(30_000),
		SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(5000)
	})
	.parse(process.env);

async function processAssignEmail(job: Job): Promise<void> {
	// Redis থেকে আসা data — অন্য process লিখেছে, তাই বিশ্বাস না করে parse
	const data = assignEmailSchema.parse(job.data);
	const res = await fetch(`${env.PROVIDER_URL}/send`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		// job.id কে provider এর কাছে key হিসেবে পাঠাই — আসল provider এ এটা idempotency key এর জায়গা
		body: JSON.stringify({ key: job.id, to: data.to }),
		// বাইরের call এ timeout ছাড়া কিছু না (Lesson 7.1)
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

// Graceful shutdown (Lesson 3.4): নতুন job নেওয়া বন্ধ, চলমান job শেষ হওয়া পর্যন্ত অপেক্ষা, তারপর exit।
// SIGKILL এ এর কিছুই হয় না — তখন চলমান job এর lock এর মেয়াদ শেষ হলে সেটা "stalled" হয়ে ফেরে।
async function shutdown(signal: string): Promise<void> {
	console.log(`worker ${process.pid}: ${signal} — চলমান job শেষ করে বন্ধ হচ্ছি`);
	await worker.close();
	process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void worker.waitUntilReady().then(() => process.send?.({ ready: true, port: 0 }));
