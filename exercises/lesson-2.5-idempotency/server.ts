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
// NOTE: এই exercise এ Map ব্যবহার করা হয়েছে শুধু demonstration এর জন্য।
// Production এ (Module 4.4 এর পরে) এটা Redis এ থাকা উচিত, কারণ:
//   1. Server restart হলে in-memory data হারিয়ে যায় (durability নেই)
//   2. Horizontal scaling এ (Lesson 1.6) একাধিক server এর মধ্যে এই state শেয়ার হবে না
const idempotencyStore = new Map<string, IdempotencyRecord>();
const tasks: Task[] = [];

// ---------- Validation Schema ----------
// Runtime input (req.body) কখনো সরাসরি বিশ্বাস করা হয় না — Zod দিয়ে parse করা হয়
const createTaskSchema = z.object({
	title: z.string().min(1, 'title is required and cannot be empty'),
	description: z.string().optional()
});

type CreateTaskInput = z.infer<typeof createTaskSchema>;

// ---------- Error Contract Helper ----------
// exactOptionalPropertyTypes: true থাকায়, `details: undefined` explicitly assign করা যায় না,
// তাই conditional object construction করা হয়েছে
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

		// ধাপ ১: এই key আগে দেখা গেছে কিনা check করো — যদি হ্যাঁ, cached result ফেরত দাও,
		// আবার business logic execute কোরো না (এটাই idempotency এর মূল কথা)
		const cached = idempotencyStore.get(idempotencyKey);
		if (cached !== undefined) {
			res.status(cached.statusCode).json(cached.body);
			return;
		}

		// ধাপ ২: body validate করো
		const parseResult = createTaskSchema.safeParse(req.body);
		if (!parseResult.success) {
			const body = buildErrorResponse(
				'VALIDATION_ERROR',
				'Request body failed validation.',
				parseResult.error.flatten()
			);
			// Validation error cache করা হয় না: কিছুই execute হয়নি, তাই client body ঠিক করে
			// একই key দিয়ে retry করলে সেটা নতুন করে process হওয়া উচিত (Stripe ও তাই করে)
			res.status(422).json(body);
			return;
		}

		// ধাপ ৩: actual "write" — এটাই সেই non-idempotent অংশ যেটা আমরা রক্ষা করছি
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
