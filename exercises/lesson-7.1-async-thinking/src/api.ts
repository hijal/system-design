import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { AcquireTimeoutError, Pool } from './pool';
import { modes, type Mode } from './modes';
import { JobQueue } from './queue';

// Lesson 7.1 — TaskFlow এর API, একটাই route এর চারটা সংস্করণ (MODE env দিয়ে বাছা):
//
//   sync-in-tx         — transaction এর ভেতরে email পাঠিয়ে তারপর commit (§০ এর আসল code)
//   sync-after-commit  — আগে commit, connection ফেরত, তারপর email এর জন্য অপেক্ষা (§১.৪)
//   fire-and-forget    — commit, তারপর `void sendEmail()` — অপেক্ষা না করেই উত্তর (§১.৪)
//   queue              — commit, job queue তে লেখা, উত্তর; worker পরে পাঠায় (§১.৫)
//
// GET /api/tasks এ email এর কোনো সম্পর্ক নেই — শুধু pool থেকে একটা ছোট query। এটাই দেখার জিনিস:
// অন্য route এর dependency ধীর হলে এই route এর কী হয়।

const env = z
	.object({
		MODE: z.enum(modes),
		PROVIDER_URL: z.string().url(),
		POOL_MAX: z.coerce.number().int().positive().default(10),
		ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
		WORKERS: z.coerce.number().int().positive().default(8)
	})
	.parse(process.env);

const assignSchema = z.object({ assigneeEmail: z.string().email() });
const taskIdSchema = z.coerce.number().int().positive();

const QUERY_MS = 5; // একটা সাধারণ indexed query (Lesson 5.4)

const pool = new Pool(env.POOL_MAX, env.ACQUIRE_TIMEOUT_MS);

// "Email এখনো যায়নি" এমন কাজ — এই process এর memory তে। Process মরলে এগুলোর কী হয়, সেটাই
// README এর experiment ২।
let pendingEmails = 0;
let peakPendingEmails = 0;
let failedEmails = 0;
const emailDelaysMs: number[] = [];

type EmailJob = { taskId: number; to: string; acceptedAt: number };

async function sendEmail(job: EmailJob): Promise<void> {
	// ইচ্ছা করে কোনো timeout নেই — `fetch`, axios, আর বেশিরভাগ SDK এর default এ এমনই থাকে
	const res = await fetch(`${env.PROVIDER_URL}/send`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ to: job.to, taskId: job.taskId })
	});
	if (!res.ok) throw new Error(`provider responded ${res.status}`);
}

// প্রতিটা email এর হিসাব: কাজটা "নেওয়া" হলে pending, পৌঁছালে বা ব্যর্থ হলে শেষ
function deliver(job: EmailJob): Promise<void> {
	return sendEmail(job)
		.then(() => {
			emailDelaysMs.push(Date.now() - job.acceptedAt);
		})
		.catch((error: unknown) => {
			failedEmails++;
			throw error;
		})
		.finally(() => {
			pendingEmails--;
		});
}

function markPending(): void {
	pendingEmails++;
	peakPendingEmails = Math.max(peakPendingEmails, pendingEmails);
}

const queue = new JobQueue<EmailJob>(env.WORKERS, deliver);

async function assign(mode: Mode, job: EmailJob): Promise<void> {
	const connection = await pool.acquire();
	switch (mode) {
		case 'sync-in-tx':
			// BEGIN … UPDATE tasks … INSERT activity … [email] … COMMIT — connection পুরো সময় ধরা
			try {
				await connection.query(QUERY_MS);
				markPending();
				await deliver(job);
				await connection.query(1); // COMMIT
			} finally {
				connection.release();
			}
			return;
		case 'sync-after-commit':
			try {
				await connection.query(QUERY_MS);
			} finally {
				connection.release();
			}
			markPending();
			await deliver(job);
			return;
		case 'fire-and-forget':
			try {
				await connection.query(QUERY_MS);
			} finally {
				connection.release();
			}
			// কেউ অপেক্ষা করছে না — ব্যর্থ হলে শুধু গুনে রাখা, কাউকে জানানো না
			markPending();
			deliver(job).catch(() => {});
			return;
		case 'queue':
			try {
				await connection.query(QUERY_MS);
			} finally {
				connection.release();
			}
			markPending();
			queue.add(job);
			return;
	}
}

function fail(res: Response, error: unknown): void {
	if (error instanceof AcquireTimeoutError) {
		res.status(503).json({ error: 'POOL_EXHAUSTED' });
		return;
	}
	res.status(500).json({ error: 'INTERNAL' });
}

const app = express();
app.use(express.json());

app.post('/api/tasks/:id/assign', async (req: Request, res: Response): Promise<void> => {
	const taskId = taskIdSchema.safeParse(req.params['id']);
	const body = assignSchema.safeParse(req.body);
	if (!taskId.success || !body.success) {
		res.status(400).json({ error: 'VALIDATION_ERROR' });
		return;
	}
	try {
		await assign(env.MODE, {
			taskId: taskId.data,
			to: body.data.assigneeEmail,
			acceptedAt: Date.now()
		});
		res.json({ taskId: taskId.data, assigned: true });
	} catch (error: unknown) {
		fail(res, error);
	}
});

app.get('/api/tasks', async (_req: Request, res: Response): Promise<void> => {
	try {
		const connection = await pool.acquire();
		try {
			await connection.query(QUERY_MS);
		} finally {
			connection.release();
		}
		res.json({ tasks: [] });
	} catch (error: unknown) {
		fail(res, error);
	}
});

// Pool ব্যবহার করে না — তাই pool ফুরিয়ে গেলেও scenario ভেতরের অবস্থা দেখতে পায়
app.get('/internal/stats', (_req: Request, res: Response): void => {
	res.json({
		pool: pool.stats(),
		queue: queue.stats(),
		pendingEmails,
		peakPendingEmails,
		failedEmails,
		emailDelaysMs
	});
});

const server = app.listen(0, '127.0.0.1', () => {
	const address = server.address();
	if (address && typeof address === 'object') process.send?.({ ready: true, port: address.port });
});
