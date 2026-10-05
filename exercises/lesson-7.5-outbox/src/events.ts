import { Redis } from 'ioredis';
import { z } from 'zod';

// The event contract: a past-tense name ("was created"), a fixed eventId (the consumer's dedupe key — 7.4),
// when it happened, and whatever a consumer may need. A version is kept so old consumers don't break when the shape changes.

export const STREAM = 'events:comments';

export const commentCreatedSchema = z.object({
	eventId: z.string().uuid(),
	type: z.literal('comment.created'),
	version: z.literal(1),
	occurredAt: z.string(),
	taskId: z.number().int().positive(),
	commentId: z.number().int().positive()
});
export type CommentCreated = z.infer<typeof commentCreatedSchema>;

// The writer and relay should fail fast: without Redis, don't queue commands up and wait forever (Lesson 7.3 1.8)
export function connectRedis(): Redis {
	return new Redis({
		host: process.env.REDIS_HOST ?? '127.0.0.1',
		port: Number(process.env.REDIS_PORT ?? 6382),
		maxRetriesPerRequest: 1,
		enableOfflineQueue: false,
		retryStrategy: () => 200
	});
}

// enableOfflineQueue is off, so a command sent before the connection is ready fails immediately — wait at the start
export function waitReady(redis: Redis): Promise<void> {
	if (redis.status === 'ready') return Promise.resolve();
	return new Promise((resolve) => redis.once('ready', () => resolve()));
}

export async function publish(redis: Redis, event: CommentCreated): Promise<void> {
	await redis.xadd(STREAM, '*', 'eventId', event.eventId, 'data', JSON.stringify(event));
}
