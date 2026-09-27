import { Redis } from 'ioredis';
import { z } from 'zod';

// Event এর চুক্তি: নাম অতীত কালে ("তৈরি হলো"), একটা স্থির eventId (consumer এর dedupe key — 7.4),
// কখন ঘটেছে, আর যা যা consumer এর লাগতে পারে। Version রাখা হয় যাতে আকৃতি বদলালে পুরনো consumer ভাঙে না।

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

// Writer আর relay দ্রুত ব্যর্থ হোক: Redis না থাকলে command জমিয়ে রেখে অনন্ত অপেক্ষা না (Lesson 7.3 ১.৮)
export function connectRedis(): Redis {
	return new Redis({
		host: process.env.REDIS_HOST ?? '127.0.0.1',
		port: Number(process.env.REDIS_PORT ?? 6382),
		maxRetriesPerRequest: 1,
		enableOfflineQueue: false,
		retryStrategy: () => 200
	});
}

// enableOfflineQueue বন্ধ, তাই connection তৈরি হওয়ার আগে command পাঠালে সাথে সাথে ব্যর্থ — শুরুতে অপেক্ষা
export function waitReady(redis: Redis): Promise<void> {
	if (redis.status === 'ready') return Promise.resolve();
	return new Promise((resolve) => redis.once('ready', () => resolve()));
}

export async function publish(redis: Redis, event: CommentCreated): Promise<void> {
	await redis.xadd(STREAM, '*', 'eventId', event.eventId, 'data', JSON.stringify(event));
}
