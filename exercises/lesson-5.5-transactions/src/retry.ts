import { DatabaseError, OptimisticLockError } from 'sequelize';
import { z } from 'zod';
import { sleep } from './db';

// Postgres এর error code গুলো SQLSTATE — Sequelize এর DatabaseError এর `original` এ থাকে।
// `original` এর type এ `code` নেই, তাই `as` দিয়ে চাপা না দিয়ে Zod দিয়ে যাচাই।
const pgError = z.object({ code: z.string() });

const RETRYABLE_CODES = new Set([
	'40001', // serialization_failure — REPEATABLE READ / SERIALIZABLE এর "আবার চেষ্টা করো"
	'40P01' // deadlock_detected — Postgres একটা transaction কে বলি দিয়েছে
]);

export function pgErrorCode(error: unknown): string | undefined {
	if (!(error instanceof DatabaseError)) return undefined;
	const parsed = pgError.safeParse(error.original);
	return parsed.success ? parsed.data.code : undefined;
}

export function isRetryable(error: unknown): boolean {
	if (error instanceof OptimisticLockError) return true;
	const code = pgErrorCode(error);
	return code !== undefined && RETRYABLE_CODES.has(code);
}

export type RetryStats = { retries: number };

// পুরো transaction টা আবার চালানো — শুধু ব্যর্থ query টা না। কারণ transaction এর ভেতরে যা
// পড়া হয়েছিল সেটাই এখন পুরনো; নতুন করে পড়ে নতুন করে সিদ্ধান্ত নিতে হবে।
// Backoff + jitter: সবাই একসাথে আবার চেষ্টা করলে আবার একসাথে ধাক্কা খাবে (Lesson 4.6, 7.4)।
export async function withRetry<T>(
	fn: () => Promise<T>,
	stats: RetryStats,
	maxAttempts = 50
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error: unknown) {
			if (!isRetryable(error) || attempt >= maxAttempts) throw error;
			stats.retries++;
			const backoff = Math.min(100, 2 ** Math.min(attempt, 6));
			await sleep(Math.random() * backoff);
		}
	}
}
