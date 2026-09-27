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

// Lesson 7.3 — TaskFlow API, producer এর দিক। Assign route এর কাজ এখন দুটো:
//   ১. (database এ assign — Lesson 7.1 এ দেখেছি, এখানে বাদ; আজকের প্রশ্ন queue)
//   ২. Redis এর BullMQ queue তে একটা job যোগ — তারপর সাথে সাথে 202
// Email পাঠানো worker.ts এর দায়িত্ব, আলাদা process এ।

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
		// queue.add ফেরে যখন job টা Redis এ লেখা হয়ে গেছে — এর পরে API process মরলেও job থাকে
		const job = await queue.add(JOB_ASSIGN_EMAIL, data, {
			...assignJobOptions(env.ATTEMPTS),
			jobId: assignJobId(data)
		});
		res.status(202).json({ taskId: data.taskId, jobId: job.id });
	} catch (error: unknown) {
		// Redis পাওয়া যাচ্ছে না — job লেখা হয়নি। চুপ করে 202 দেওয়া মানে 7.1 এর fire-and-forget।
		console.error('enqueue failed:', error instanceof Error ? error.message : error);
		res.status(503).json({ error: 'QUEUE_UNAVAILABLE' });
	}
});

// Job এর অবস্থা — লম্বা কাজের জন্য client এই endpoint এ জিজ্ঞেস করে (Lesson 7.1 এর 202 + polling)
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
