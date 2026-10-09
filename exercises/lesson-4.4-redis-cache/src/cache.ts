import Redis from 'ioredis';
import { z } from 'zod';

const REDIS_URL: string = process.env.REDIS_URL ?? 'redis://localhost:6380';

export const redis = new Redis(REDIS_URL, {
	// Goal: if Redis is slow or down, give up fast and fall back to the DB (Lesson 4.2: "the cache is optional").
	// But careful - these two options alone don't guarantee that. Because ioredis's offline queue
	// (enableOfflineQueue, default true) is on, when Redis is down every command sits in the queue
	// waiting for a reconnect, and latency reaches seconds. This is left in deliberately -
	// in Lesson 4.4's experiment 4 you will measure it and fix it yourself.
	maxRetriesPerRequest: 1,
	connectTimeout: 1000
});

// What comes from Redis is runtime input - so it is parsed with a schema,
// not trusted with a type assertion (`as`) (main.md §6).
export const taskSchema = z.object({
	id: z.number().int(),
	userId: z.number().int(),
	title: z.string(),
	completed: z.boolean()
});
export const taskListSchema = z.array(taskSchema);
export type TaskDTO = z.infer<typeof taskSchema>;

// The cache result is a discriminated union - not a jungle of optional fields
// (main.md §6). 'error' is kept separate so that "Redis is missing" and "not in the cache"
// can be measured separately.
export type CacheLookup<T> =
	{ status: 'hit'; value: T } | { status: 'miss' } | { status: 'error'; reason: string };

function describeError(error: unknown): string {
	// not catch (e: any) - caught as unknown and narrowed
	if (error instanceof Error) return error.message;
	return String(error);
}

export async function readList(key: string): Promise<CacheLookup<TaskDTO[]>> {
	try {
		const raw = await redis.get(key);
		if (raw === null) return { status: 'miss' };

		const parsed: unknown = JSON.parse(raw);
		const result = taskListSchema.safeParse(parsed);
		if (!result.success) {
			// garbage in the cache - treat it as a miss, the DB is the source of truth
			return { status: 'miss' };
		}
		return { status: 'hit', value: result.data };
	} catch (error: unknown) {
		return { status: 'error', reason: describeError(error) };
	}
}

export async function writeList(key: string, value: TaskDTO[], ttlSeconds: number): Promise<void> {
	try {
		await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
	} catch {
		// The lesson of Lesson 4.3 question 3: failing to write to the cache should never
		// be a reason to fail the request. So it is quietly let go here.
	}
}

export async function invalidate(...keys: string[]): Promise<void> {
	try {
		if (keys.length > 0) await redis.del(...keys);
	} catch {
		// the same reasoning - if invalidate fails, the TTL acts as a safety net
	}
}

// Key naming follows a rule (Lesson 4.3) - namespace:entity:id
export const keys = {
	tasksByUser: (userId: number): string => `tasks:user:${userId}`,
	completedByUser: (userId: number): string => `tasks:user:${userId}:completed`
};
