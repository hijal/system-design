import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { Task, sequelize } from './db';
import { invalidate, keys, readList, writeList, type TaskDTO } from './cache';
import { single } from './singleflight';

const TTL_SECONDS = 60; // Lesson 4.3 এর সিদ্ধান্ত: task list এ ৩০-৬০s

// কতবার সত্যিই DB তে যাওয়া হলো — Lesson 4.6 এর stampede demo এটা পড়ে
let dbQueryCount = 0;

interface TaskListResponse {
	tasks: TaskDTO[];
	source: 'cache' | 'database';
	tookMs: number;
}

interface ApiErrorBody {
	error: { code: string; message: string };
}

const app = express();
app.use(express.json());

// শুধু demo এর জন্য: একটা "দামি query" নকল করার সুযোগ (?delay=200)।
// Stampede বাস্তবে তখনই সমস্যা হয় যখন origin এর কাজটা ধীর — query যদি
// ১০ ms এর হয়, প্রথম request শেষ হয়ে cache ভরে ফেলে বাকিরা আসার আগেই।
// Production code এ এমন কিছু থাকবে না।
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadFromDatabase(
	userId: number,
	completedOnly: boolean,
	delayMs = 0
): Promise<TaskDTO[]> {
	dbQueryCount++;
	if (delayMs > 0) await sleep(delayMs);
	const rows = await Task.findAll({
		where: completedOnly ? { userId, completed: true } : { userId },
		order: [['id', 'ASC']]
	});
	return rows.map((row) => ({
		id: row.id,
		userId: row.userId,
		title: row.title,
		completed: row.completed
	}));
}

// ---------- READ: Cache-Aside (Lesson 4.2) ----------
app.get(
	'/api/tasks',
	async (
		req: Request<Record<string, never>, TaskListResponse | ApiErrorBody, unknown>,
		res: Response<TaskListResponse | ApiErrorBody>
	): Promise<void> => {
		const started = process.hrtime.bigint();

		const userId = Number(req.query.userId);
		if (!Number.isInteger(userId)) {
			res
				.status(400)
				.json({ error: { code: 'BAD_USER_ID', message: 'userId must be an integer' } });
			return;
		}
		const completedOnly = req.query.completed === 'true';
		const key = completedOnly ? keys.completedByUser(userId) : keys.tasksByUser(userId);

		const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1_000_000;

		// ধাপ ১ — cache
		const lookup = await readList(key);
		if (lookup.status === 'hit') {
			res.setHeader('X-Cache', 'HIT');
			res.status(200).json({ tasks: lookup.value, source: 'cache', tookMs: elapsed() });
			return;
		}
		res.setHeader('X-Cache', lookup.status === 'error' ? 'ERROR' : 'MISS');

		// ধাপ ২ — DB। ?sf=1 দিলে single-flight চালু, তখন একই key এর
		// concurrent miss গুলো একটাই DB query ভাগ করে নেয় (Lesson 4.6)।
		const useSingleFlight = req.query.sf === '1';
		const delayMs = Number(req.query.delay ?? 0);
		const safeDelay = Number.isFinite(delayMs) && delayMs > 0 ? Math.min(delayMs, 5_000) : 0;

		// গুরুত্বপূর্ণ: single-flight এর ভেতরে DB load **আর** cache write —
		// দুটোই থাকতে হবে। শুধু load টা মুড়লে একটা সরু ফাঁক থেকে যায়:
		// load শেষ হয়ে in-flight entry মুছে গেছে, কিন্তু cache তখনো লেখা হয়নি —
		// ঠিক সেই মুহূর্তে আসা request টা miss করবে এবং আরেকটা load শুরু করবে।
		const loadAndCache = async (): Promise<TaskDTO[]> => {
			const rows = await loadFromDatabase(userId, completedOnly, safeDelay);
			await writeList(key, rows, TTL_SECONDS);
			return rows;
		};

		// ধাপ ২ + ৩ — DB থেকে এনে cache এ রেখে দাও
		const tasks = useSingleFlight ? await single(key, loadAndCache) : await loadAndCache();

		res.status(200).json({ tasks, source: 'database', tookMs: elapsed() });
	}
);

// ---------- WRITE: আগে DB, পরে invalidate (Lesson 4.3) ----------
const patchSchema = z.object({
	title: z.string().min(1).optional(),
	completed: z.boolean().optional()
});

app.patch(
	'/api/tasks/:id',
	async (
		req: Request<
			{ id: string },
			{ updated: TaskDTO; invalidated: string[] } | ApiErrorBody,
			unknown
		>,
		res: Response<{ updated: TaskDTO; invalidated: string[] } | ApiErrorBody>
	): Promise<void> => {
		const taskId = Number(req.params.id);
		if (!Number.isInteger(taskId)) {
			res.status(400).json({ error: { code: 'BAD_TASK_ID', message: 'id must be an integer' } });
			return;
		}

		const parsed = patchSchema.safeParse(req.body);
		if (!parsed.success) {
			res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'invalid body' } });
			return;
		}

		const task = await Task.findByPk(taskId);
		if (task === null) {
			res.status(404).json({ error: { code: 'NOT_FOUND', message: 'task not found' } });
			return;
		}

		// ধাপ ১ — সত্যের উৎস আগে
		if (parsed.data.title !== undefined) task.title = parsed.data.title;
		if (parsed.data.completed !== undefined) task.completed = parsed.data.completed;
		await task.save();

		// ধাপ ২ — তারপর cache। লক্ষ্য করো: শুধু `tasks:user:N` না,
		// derived view `:completed` টাও মুছতে হচ্ছে (Lesson 4.3, প্রশ্ন ১)।
		const affected = [keys.tasksByUser(task.userId), keys.completedByUser(task.userId)];
		await invalidate(...affected);

		res.status(200).json({
			updated: { id: task.id, userId: task.userId, title: task.title, completed: task.completed },
			invalidated: affected
		});
	}
);

app.get('/api/_stats', (_req: Request, res: Response<{ dbQueryCount: number }>): void => {
	res.status(200).json({ dbQueryCount });
});

app.post('/api/_stats/reset', (_req: Request, res: Response<{ dbQueryCount: number }>): void => {
	dbQueryCount = 0;
	res.status(200).json({ dbQueryCount });
});

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
	await sequelize.authenticate();
	app.listen(PORT, (): void => {
		console.log(`TaskFlow cache demo listening on port ${PORT}`);
	});
}

main().catch((error: unknown): void => {
	console.error('startup failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
