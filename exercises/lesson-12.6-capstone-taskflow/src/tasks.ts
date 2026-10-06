import { createHash, randomUUID } from 'node:crypto';
import { QueryTypes, type Transaction } from 'sequelize';
import { z } from 'zod';
import { IdempotencyKey, OutboxEvent, sequelize, Task } from './db';
import type { TaskEvent } from './events';

export type TaskDto = {
	id: number;
	boardId: number;
	title: string;
	column: string;
	position: number;
	assigneeId: string | null;
	version: number;
};

export type CreateInput = {
	boardId: number;
	title: string;
	assigneeId: string | null;
};

export type UpdateInput = {
	version: number;
	column?: string;
	position?: number;
	assigneeId?: string | null;
};

export type CreateResult =
	{ status: 201; task: TaskDto; replayed: boolean } | { status: 422; error: string };

export type UpdateResult =
	{ status: 200; task: TaskDto } | { status: 404 } | { status: 409; current: TaskDto };

export const toDto = (task: Task): TaskDto => ({
	id: task.id,
	boardId: task.boardId,
	title: task.title,
	column: task.column,
	position: task.position,
	assigneeId: task.assigneeId,
	version: task.version
});

const taskDtoSchema = z.object({
	id: z.number(),
	boardId: z.number(),
	title: z.string(),
	column: z.string(),
	position: z.number(),
	assigneeId: z.string().nullable(),
	version: z.number()
});

const insertedKeySchema = z.array(z.object({ key: z.string() }));

export const requestHash = (input: CreateInput): string =>
	createHash('sha256')
		.update(JSON.stringify([input.boardId, input.title, input.assigneeId]))
		.digest('hex');

export async function writeEvents(
	events: readonly TaskEvent[],
	transaction: Transaction
): Promise<void> {
	if (events.length === 0) return;
	await OutboxEvent.bulkCreate(
		events.map((event) => ({
			eventId: event.eventId,
			type: event.type,
			taskId: event.taskId,
			payload: event,
			publishedAt: null
		})),
		{ transaction }
	);
}

export function createdEvents(task: Task): TaskEvent[] {
	const events: TaskEvent[] = [
		{ type: 'task.created', eventId: randomUUID(), taskId: task.id, boardId: task.boardId }
	];
	if (task.assigneeId !== null) {
		events.push({
			type: 'task.assigned',
			eventId: randomUUID(),
			taskId: task.id,
			assigneeId: task.assigneeId,
			title: task.title
		});
	}
	return events;
}

async function insertTask(input: CreateInput, transaction: Transaction): Promise<Task> {
	const last = await Task.max<number | null, Task>('position', {
		where: { boardId: input.boardId, column: 'todo' },
		transaction
	});
	return Task.create(
		{
			boardId: input.boardId,
			title: input.title,
			column: 'todo',
			position: (last ?? 0) + 1,
			assigneeId: input.assigneeId
		},
		{ transaction }
	);
}

export async function createTask(
	input: CreateInput,
	idempotencyKey: string | undefined
): Promise<CreateResult> {
	return sequelize.transaction(async (transaction) => {
		if (idempotencyKey !== undefined) {
			const hash = requestHash(input);
			const inserted = insertedKeySchema.parse(
				await sequelize.query(
					`INSERT INTO idempotency_keys (key, request_hash, status_code, response_body, created_at)
					 VALUES (:key, :hash, 0, '{}'::jsonb, now())
					 ON CONFLICT (key) DO NOTHING
					 RETURNING key`,
					{
						replacements: { key: idempotencyKey, hash },
						type: QueryTypes.SELECT,
						transaction
					}
				)
			);
			if (inserted.length === 0) {
				const existing = await IdempotencyKey.findByPk(idempotencyKey, { transaction });
				if (existing === null) throw new Error('idempotency key vanished after a conflict');
				if (existing.requestHash !== hash) {
					return { status: 422, error: 'this Idempotency-Key was used with a different request' };
				}
				return {
					status: 201,
					task: taskDtoSchema.parse(existing.responseBody),
					replayed: true
				};
			}
		}

		const task = await insertTask(input, transaction);
		await writeEvents(createdEvents(task), transaction);
		const dto = toDto(task);
		if (idempotencyKey !== undefined) {
			await IdempotencyKey.update(
				{ statusCode: 201, responseBody: dto },
				{ where: { key: idempotencyKey }, transaction }
			);
		}
		return { status: 201, task: dto, replayed: false };
	});
}

function changesFor(
	current: Task,
	input: UpdateInput
): { column: string; position: number; assigneeId: string | null } {
	return {
		column: input.column ?? current.column,
		position: input.position ?? current.position,
		assigneeId: input.assigneeId === undefined ? current.assigneeId : input.assigneeId
	};
}

function updatedEvents(before: Task, after: Task): TaskEvent[] {
	const events: TaskEvent[] = [];
	if (before.column !== after.column || before.position !== after.position) {
		events.push({
			type: 'task.moved',
			eventId: randomUUID(),
			taskId: after.id,
			column: after.column,
			position: after.position
		});
	}
	if (after.assigneeId !== null && before.assigneeId !== after.assigneeId) {
		events.push({
			type: 'task.assigned',
			eventId: randomUUID(),
			taskId: after.id,
			assigneeId: after.assigneeId,
			title: after.title
		});
	}
	return events;
}

export async function updateTask(id: number, input: UpdateInput): Promise<UpdateResult> {
	return sequelize.transaction(async (transaction) => {
		const before = await Task.findByPk(id, { transaction });
		if (before === null) return { status: 404 };
		if (before.version !== input.version) return { status: 409, current: toDto(before) };

		const [count, rows] = await Task.update(
			{ ...changesFor(before, input), version: input.version + 1 },
			{ where: { id, version: input.version }, returning: true, transaction }
		);
		const after = rows[0];
		if (count === 0 || after === undefined) {
			const latest = await Task.findByPk(id, { transaction });
			if (latest === null) return { status: 404 };
			return { status: 409, current: toDto(latest) };
		}
		await writeEvents(updatedEvents(before, after), transaction);
		return { status: 200, task: toDto(after) };
	});
}

export async function updateTaskNaive(id: number, input: UpdateInput): Promise<UpdateResult> {
	return sequelize.transaction(async (transaction) => {
		const before = await Task.findByPk(id, { transaction });
		if (before === null) return { status: 404 };
		const [, rows] = await Task.update(
			{ ...changesFor(before, input), version: before.version + 1 },
			{ where: { id }, returning: true, transaction }
		);
		const after = rows[0];
		if (after === undefined) return { status: 404 };
		await writeEvents(updatedEvents(before, after), transaction);
		return { status: 200, task: toDto(after) };
	});
}
