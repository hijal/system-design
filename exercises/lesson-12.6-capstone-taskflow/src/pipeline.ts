import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { config } from './config';
import { Notification, sequelize } from './db';
import { taskEventSchema, type TaskEvent } from './events';
import type { FakeEmailProvider } from './provider';

export class SimulatedCrash extends Error {
	constructor(where: string) {
		super(`simulated crash: ${where}`);
		this.name = 'SimulatedCrash';
	}
}

export type Hooks = {
	crashAfterEnqueue?: (event: TaskEvent) => boolean;
	crashAfterSend?: (event: TaskEvent, attempt: number) => boolean;
};

const outboxRowSchema = z.array(z.object({ id: z.coerce.number(), payload: z.unknown() }));

export function connect(): IORedis {
	return new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

export function createQueue(name: string, connection: IORedis): Queue {
	return new Queue(name, {
		connection,
		defaultJobOptions: {
			attempts: 5,
			backoff: { type: 'fixed', delay: 20 },
			removeOnComplete: true,
			removeOnFail: false
		}
	});
}

export async function relayBatch(
	queue: Queue,
	limit: number,
	hooks: Hooks = {}
): Promise<{ published: number; crashed: boolean }> {
	try {
		return await sequelize.transaction(async (transaction) => {
			const rows = outboxRowSchema.parse(
				await sequelize.query(
					`SELECT id, payload FROM outbox_events
					 WHERE published_at IS NULL
					 ORDER BY id
					 LIMIT :limit
					 FOR UPDATE SKIP LOCKED`,
					{ replacements: { limit }, type: QueryTypes.SELECT, transaction }
				)
			);
			for (const row of rows) {
				const event = taskEventSchema.parse(row.payload);
				await queue.add(event.type, event, { jobId: event.eventId });
				if (hooks.crashAfterEnqueue?.(event) === true)
					throw new SimulatedCrash('relay after enqueue');
			}
			if (rows.length > 0) {
				await sequelize.query(`UPDATE outbox_events SET published_at = now() WHERE id IN (:ids)`, {
					replacements: { ids: rows.map((row) => row.id) },
					transaction
				});
			}
			return { published: rows.length, crashed: false };
		});
	} catch (error: unknown) {
		if (error instanceof SimulatedCrash) return { published: 0, crashed: true };
		throw error;
	}
}

export async function relayUntilEmpty(queue: Queue, hooks: Hooks = {}): Promise<number> {
	let crashes = 0;
	for (;;) {
		const result = await relayBatch(queue, 100, hooks);
		if (result.crashed) crashes++;
		else if (result.published === 0) return crashes;
	}
}

export function startWorker(
	queueName: string,
	connection: IORedis,
	provider: FakeEmailProvider,
	hooks: Hooks = {}
): Worker {
	return new Worker(
		queueName,
		async (job: Job): Promise<string> => {
			const event = taskEventSchema.parse(job.data);
			if (event.type !== 'task.assigned') return 'ignored';
			await sequelize.query(
				`INSERT INTO notifications (event_id, task_id, recipient_id, status, created_at)
				 VALUES (:eventId, :taskId, :recipientId, 'pending', now())
				 ON CONFLICT (event_id) DO NOTHING`,
				{
					replacements: {
						eventId: event.eventId,
						taskId: event.taskId,
						recipientId: event.assigneeId
					}
				}
			);
			const row = await Notification.findByPk(event.eventId);
			if (row?.status === 'sent') return 'duplicate';
			await provider.send({
				idempotencyKey: event.eventId,
				to: event.assigneeId,
				taskId: event.taskId
			});
			if (hooks.crashAfterSend?.(event, job.attemptsMade) === true) {
				throw new SimulatedCrash('worker after send');
			}
			await Notification.update({ status: 'sent' }, { where: { eventId: event.eventId } });
			return 'sent';
		},
		{ connection, concurrency: 10 }
	);
}

export async function waitForQueue(queue: Queue): Promise<void> {
	for (;;) {
		const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
		const pending =
			(counts.waiting ?? 0) +
			(counts.active ?? 0) +
			(counts.delayed ?? 0) +
			(counts.prioritized ?? 0);
		if (pending === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
