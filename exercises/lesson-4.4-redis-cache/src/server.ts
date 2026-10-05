import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { Task, sequelize } from './db';
import { invalidate, keys, readList, writeList, type TaskDTO } from './cache';
import { single } from './singleflight';

const TTL_SECONDS = 60; // Lesson 4.3's decision: 30-60s for the task list

// how many times we actually went to the DB — Lesson 4.6's stampede demo reads this
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

// For the demo only: a way to imitate an "expensive query" (?delay=200).
// A stampede is a real problem only when the origin's work is slow — if the query
// takes 10 ms, the first request finishes and fills the cache before the rest arrive.
// Production code would have nothing like this.
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

		// step 1 — cache
		const lookup = await readList(key);
		if (lookup.status === 'hit') {
			res.setHeader('X-Cache', 'HIT');
			res.status(200).json({ tasks: lookup.value, source: 'cache', tookMs: elapsed() });
			return;
		}
		res.setHeader('X-Cache', lookup.status === 'error' ? 'ERROR' : 'MISS');

		// step 2 — DB. With ?sf=1 single-flight is on, and then concurrent misses of the
		// same key share a single DB query (Lesson 4.6).
		const useSingleFlight = req.query.sf === '1';
		const delayMs = Number(req.query.delay ?? 0);
		const safeDelay = Number.isFinite(delayMs) && delayMs > 0 ? Math.min(delayMs, 5_000) : 0;

		// Important: inside single-flight the DB load **and** the cache write —
		// both have to be there. Wrapping only the load leaves a narrow gap:
		// the load has finished and the in-flight entry is gone, but the cache is not written yet —
		// a request arriving at exactly that moment will miss and start another load.
		const loadAndCache = async (): Promise<TaskDTO[]> => {
			const rows = await loadFromDatabase(userId, completedOnly, safeDelay);
			await writeList(key, rows, TTL_SECONDS);
			return rows;
		};

		// step 2 + 3 — fetch from the DB and keep it in the cache
		const tasks = useSingleFlight ? await single(key, loadAndCache) : await loadAndCache();

		res.status(200).json({ tasks, source: 'database', tookMs: elapsed() });
	}
);

// ---------- WRITE: DB first, then invalidate (Lesson 4.3) ----------
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

		// step 1 — the source of truth first
		if (parsed.data.title !== undefined) task.title = parsed.data.title;
		if (parsed.data.completed !== undefined) task.completed = parsed.data.completed;
		await task.save();

		// step 2 — then the cache. Note: not just `tasks:user:N`,
		// the derived view `:completed` has to be deleted too (Lesson 4.3, question 1).
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
