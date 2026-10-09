import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { AcquireTimeoutError, Pool } from './pool';
import { modes, type Mode } from './modes';
import { JobQueue } from './queue';

// Lesson 7.1 - TaskFlow's API, four versions of a single route (chosen with the MODE env):
//
//   sync-in-tx         - send the email inside the transaction, then commit (the real code from §0)
//   sync-after-commit  - commit first, return the connection, then wait for the email (§1.4)
//   fire-and-forget    - commit, then `void sendEmail()` - respond without waiting (§1.4)
//   queue              - commit, write to the job queue, respond; a worker sends it later (§1.5)
//
// GET /api/tasks has nothing to do with email - just one small query from the pool. This is the thing to watch:
// what happens to this route when another route's dependency gets slow.

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

const QUERY_MS = 5; // an ordinary indexed query (Lesson 5.4)

const pool = new Pool(env.POOL_MAX, env.ACQUIRE_TIMEOUT_MS);

// Work where "the email has not gone yet" - in this process's memory. What happens to it when the process dies
// is experiment 2 in the README.
let pendingEmails = 0;
let peakPendingEmails = 0;
let failedEmails = 0;
const emailDelaysMs: number[] = [];

type EmailJob = { taskId: number; to: string; acceptedAt: number };

async function sendEmail(job: EmailJob): Promise<void> {
	// Deliberately no timeout - that is the default in `fetch`, axios, and most SDKs
	const res = await fetch(`${env.PROVIDER_URL}/send`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ to: job.to, taskId: job.taskId })
	});
	if (!res.ok) throw new Error(`provider responded ${res.status}`);
}

// Bookkeeping for every email: pending once the work is "taken", done once delivered or failed
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
			// BEGIN … UPDATE tasks … INSERT activity … [email] … COMMIT - the connection is held the whole time
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
			// nobody is waiting - on failure it is only counted, nobody is told
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

// Doesn't use the pool - so the scenario can see the internal state even when the pool is exhausted
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
