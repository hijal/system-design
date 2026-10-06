import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { Task } from './db';
import { createTask, toDto, updateTask, updateTaskNaive, type UpdateInput } from './tasks';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const boardParams = z.object({ boardId: z.coerce.number().int().positive() });

const createBody = z.object({
	title: z.string().trim().min(1).max(200),
	assigneeId: z.string().min(1).max(40).nullable().default(null)
});

const updateBody = z
	.object({
		version: z.number().int().positive(),
		column: z.enum(['todo', 'doing', 'done']).optional(),
		position: z.number().int().min(0).optional(),
		assigneeId: z.string().min(1).max(40).nullable().optional()
	})
	.refine(
		(body) =>
			body.column !== undefined || body.position !== undefined || body.assigneeId !== undefined,
		'nothing to change'
	);

const idempotencyHeader = z.string().trim().min(8).max(100).optional();

type ErrorBody = { error: string; details?: unknown };

function toUpdateInput(body: z.infer<typeof updateBody>): UpdateInput {
	const input: UpdateInput = { version: body.version };
	if (body.column !== undefined) input.column = body.column;
	if (body.position !== undefined) input.position = body.position;
	if (body.assigneeId !== undefined) input.assigneeId = body.assigneeId;
	return input;
}

export function createApp(options: { naiveRoute: boolean }): Express {
	const app = express();
	app.use(express.json({ limit: '16kb' }));

	app.post('/boards/:boardId/tasks', async (req: Request, res: Response) => {
		const params = boardParams.safeParse(req.params);
		const body = createBody.safeParse(req.body);
		const key = idempotencyHeader.safeParse(req.header('Idempotency-Key'));
		if (!params.success || !body.success || !key.success) {
			const error: ErrorBody = { error: 'invalid request' };
			res.status(400).json(error);
			return;
		}
		const result = await createTask(
			{ boardId: params.data.boardId, title: body.data.title, assigneeId: body.data.assigneeId },
			key.data
		);
		if (result.status === 422) {
			res.status(422).json({ error: result.error });
			return;
		}
		if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
		res.status(201).json(result.task);
	});

	app.get('/tasks/:id', async (req: Request, res: Response) => {
		const params = idParams.safeParse(req.params);
		if (!params.success) {
			res.status(400).json({ error: 'invalid id' });
			return;
		}
		const task = await Task.findByPk(params.data.id);
		if (task === null) {
			res.status(404).json({ error: 'not found' });
			return;
		}
		res.json(toDto(task));
	});

	const update =
		(write: typeof updateTask) =>
		async (req: Request, res: Response): Promise<void> => {
			const params = idParams.safeParse(req.params);
			const body = updateBody.safeParse(req.body);
			if (!params.success || !body.success) {
				res.status(400).json({ error: 'invalid request' });
				return;
			}
			const result = await write(params.data.id, toUpdateInput(body.data));
			if (result.status === 404) res.status(404).json({ error: 'not found' });
			else if (result.status === 409)
				res.status(409).json({ error: 'version conflict', current: result.current });
			else res.json(result.task);
		};

	app.patch('/tasks/:id', update(updateTask));
	if (options.naiveRoute) app.patch('/naive/tasks/:id', update(updateTaskNaive));

	return app;
}
