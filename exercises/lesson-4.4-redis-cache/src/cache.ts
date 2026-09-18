import Redis from 'ioredis';
import { z } from 'zod';

const REDIS_URL: string = process.env.REDIS_URL ?? 'redis://localhost:6380';

export const redis = new Redis(REDIS_URL, {
	// cache যেন কখনো request কে আটকে না রাখে — Redis ধীর হলে দ্রুত হাল ছেড়ে
	// DB তে চলে যাওয়াই ভালো (Lesson 4.2: "cache optional")
	maxRetriesPerRequest: 1,
	connectTimeout: 1000
});

// Redis থেকে যা আসে সেটা runtime input — তাই schema দিয়ে parse করা হয়,
// type assertion (`as`) দিয়ে বিশ্বাস করা হয় না (main.md §৬)।
export const taskSchema = z.object({
	id: z.number().int(),
	userId: z.number().int(),
	title: z.string(),
	completed: z.boolean()
});
export const taskListSchema = z.array(taskSchema);
export type TaskDTO = z.infer<typeof taskSchema>;

// Cache এর ফলাফল একটা discriminated union — optional field এর জঙ্গল না
// (main.md §৬)। 'error' আলাদা রাখা হয়েছে যাতে "Redis নেই" আর "cache এ নেই"
// দুটো আলাদা করে মাপা যায়।
export type CacheLookup<T> =
	{ status: 'hit'; value: T } | { status: 'miss' } | { status: 'error'; reason: string };

function describeError(error: unknown): string {
	// catch (e: any) নয় — unknown ধরে narrow করা হচ্ছে
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
			// cache এ আবর্জনা — miss ধরে নাও, DB ই সত্যের উৎস
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
		// Lesson 4.3 প্রশ্ন ৩ এর শিক্ষা: cache এ লিখতে না পারা কখনোই
		// request fail করার কারণ হওয়া উচিত না। তাই এখানে চুপচাপ ছেড়ে দেওয়া হয়।
	}
}

export async function invalidate(...keys: string[]): Promise<void> {
	try {
		if (keys.length > 0) await redis.del(...keys);
	} catch {
		// একই যুক্তি — invalidate fail করলে TTL safety net হিসেবে কাজ করবে
	}
}

// Key naming একটা নিয়ম মেনে (Lesson 4.3) — namespace:entity:id
export const keys = {
	tasksByUser: (userId: number): string => `tasks:user:${userId}`,
	completedByUser: (userId: number): string => `tasks:user:${userId}:completed`
};
