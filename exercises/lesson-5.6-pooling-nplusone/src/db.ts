import { Sequelize, type PoolOptions } from 'sequelize';

export const DATABASE_URL: string =
	process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5437/taskflow';

// প্রতিটা Sequelize instance মানে নিজের আলাদা pool — ঠিক যেমন প্রতিটা Express instance
// (Lesson 1.6, 3.x) নিজের আলাদা pool চালায়।
export function createSequelize(
	pool: PoolOptions = {},
	logging: false | ((sql: string) => void) = false
): Sequelize {
	return new Sequelize(DATABASE_URL, {
		logging,
		pool: { max: 10, min: 0, idle: 10_000, ...pool }
	});
}

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[index] ?? 0;
}
