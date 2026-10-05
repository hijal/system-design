import { Queue } from 'bullmq';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import {
	assignEmailSchema,
	assignJobId,
	assignJobOptions,
	connection,
	JOB_ASSIGN_EMAIL,
	QUEUE_NAME,
	type AssignEmail
} from './config';

// Lesson 7.3 — the TaskFlow API, the producer side. The assign route now does two things:
//   1. (the assign in the database — seen in Lesson 7.1, left out here; today's question is the queue)
//   2. add a job to the BullMQ queue in Redis — then 202 right away
// Sending the email is worker.ts's job, in a separate process.

const env = z
	.object({ ATTEMPTS: z.coerce.number().int().positive().default(5) })
	.parse(process.env);

const queue = new Queue<AssignEmail>(QUEUE_NAME, { connection });

const bodySchema = z.object({
	assigneeId: z.number().int().positive(),
	assigneeEmail: z.string().email()
});
const taskIdSchema = z.coerce.number().int().positive();

const app = express();
app.use(express.json());

app.post('/api/tasks/:id/assign', async (req: Request, res: Response): Promise<void> => {
	const taskId = taskIdSchema.safeParse(req.params['id']);
	const body = bodySchema.safeParse(req.body);
	if (!taskId.success || !body.success) {
		res.status(400).json({ error: 'VALIDATION_ERROR' });
		return;
	}
	const data = assignEmailSchema.parse({
		taskId: taskId.data,
		assigneeId: body.data.assigneeId,
		to: body.data.assigneeEmail
	});
	try {
		// queue.add returns once the job is written to Redis — after this the job survives even if the API process dies
		const job = await queue.add(JOB_ASSIGN_EMAIL, data, {
			...assignJobOptions(env.ATTEMPTS),
			jobId: assignJobId(data)
		});
		res.status(202).json({ taskId: data.taskId, jobId: job.id });
	} catch (error: unknown) {
		// Redis can't be reached — the job wasn't written. Quietly returning 202 would be 7.1's fire-and-forget.
		console.error('enqueue failed:', error instanceof Error ? error.message : error);
		res.status(503).json({ error: 'QUEUE_UNAVAILABLE' });
	}
});

// The job's state — for long work the client asks this endpoint (Lesson 7.1's 202 + polling)
app.get('/api/jobs/:id', async (req: Request, res: Response): Promise<void> => {
	const job = await queue.getJob(String(req.params['id']));
	if (!job) {
		res.status(404).json({ error: 'NOT_FOUND' });
		return;
	}
	res.json({ id: job.id, state: await job.getState(), attemptsMade: job.attemptsMade });
});

const server = app.listen(0, '127.0.0.1', () => {
	const address = server.address();
	if (address && typeof address === 'object') process.send?.({ ready: true, port: address.port });
});
