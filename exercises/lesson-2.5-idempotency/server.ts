import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// ---------- Domain Types ----------

interface Task {
	id: string;
	title: string;
	description: string | null;
	createdAt: string;
}

interface ApiErrorBody {
	error: {
		code: string;
		message: string;
		details?: unknown;
	};
}

type ApiResponseBody = Task | ApiErrorBody;

interface IdempotencyRecord {
	statusCode: number;
	body: ApiResponseBody;
}

// ---------- "Storage" (in-memory for this exercise) ----------
// NOTE: this exercise uses a Map for demonstration only.
// In production (after Module 4.4) this belongs in Redis, because:
//   1. In-memory data is lost when the server restarts (no durability)
//   2. With horizontal scaling (Lesson 1.6) this state is not shared between servers
const idempotencyStore = new Map<string, IdempotencyRecord>();
const tasks: Task[] = [];

// ---------- Validation Schema ----------
// Runtime input (req.body) is never trusted directly - it is parsed with Zod
const createTaskSchema = z.object({
	title: z.string().min(1, 'title is required and cannot be empty'),
	description: z.string().optional()
});

type CreateTaskInput = z.infer<typeof createTaskSchema>;

// ---------- Error Contract Helper ----------
// With exactOptionalPropertyTypes: true, `details: undefined` cannot be assigned explicitly,
// so the object is built conditionally
function buildErrorResponse(code: string, message: string, details?: unknown): ApiErrorBody {
	if (details === undefined) {
		return { error: { code, message } };
	}
	return { error: { code, message, details } };
}

// ---------- App ----------

const app = express();
app.use(express.json());

app.post(
	'/api/tasks',
	(
		req: Request<Record<string, never>, ApiResponseBody, unknown>,
		res: Response<ApiResponseBody>
	): void => {
		const idempotencyKey = req.header('Idempotency-Key');

		if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
			const body = buildErrorResponse(
				'MISSING_IDEMPOTENCY_KEY',
				'Idempotency-Key header is required for this operation.'
			);
			res.status(400).json(body);
			return;
		}

		// Step 1: check whether this key has been seen before - if so, return the cached result
		// and don't execute the business logic again (this is the core of idempotency)
		const cached = idempotencyStore.get(idempotencyKey);
		if (cached !== undefined) {
			res.status(cached.statusCode).json(cached.body);
			return;
		}

		// Step 2: validate the body
		const parseResult = createTaskSchema.safeParse(req.body);
		if (!parseResult.success) {
			const body = buildErrorResponse(
				'VALIDATION_ERROR',
				'Request body failed validation.',
				parseResult.error.flatten()
			);
			// Validation errors are not cached: nothing was executed, so when the client fixes the body
			// and retries with the same key, it should be processed afresh (Stripe does the same)
			res.status(422).json(body);
			return;
		}

		// Step 3: the actual "write" - this is the non-idempotent part we are protecting
		const input: CreateTaskInput = parseResult.data;
		const newTask: Task = {
			id: randomUUID(),
			title: input.title,
			description: input.description ?? null,
			createdAt: new Date().toISOString()
		};
		tasks.push(newTask);

		idempotencyStore.set(idempotencyKey, { statusCode: 201, body: newTask });
		res.status(201).json(newTask);
	}
);

app.get('/api/tasks', (_req: Request, res: Response<{ tasks: Task[]; count: number }>): void => {
	res.status(200).json({ tasks, count: tasks.length });
});

const PORT = 3000;
app.listen(PORT, (): void => {
	console.log(`TaskFlow idempotency demo server listening on port ${PORT}`);
});
