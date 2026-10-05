import { DatabaseError, OptimisticLockError } from 'sequelize';
import { z } from 'zod';
import { sleep } from './db';

// Postgres's error codes are SQLSTATE — kept in the `original` of Sequelize's DatabaseError.
// `original`'s type has no `code`, so it is checked with Zod rather than silenced with `as`.
const pgError = z.object({ code: z.string() });

const RETRYABLE_CODES = new Set([
	'40001', // serialization_failure — REPEATABLE READ / SERIALIZABLE's "try again"
	'40P01' // deadlock_detected — Postgres sacrificed one transaction
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

// Rerunning the whole transaction — not just the failed query. Because whatever was read inside the
// transaction is now stale; it has to be read afresh and the decision made afresh.
// Backoff + jitter: if everyone retries at once, they collide at once again (Lesson 4.6, 7.4).
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
