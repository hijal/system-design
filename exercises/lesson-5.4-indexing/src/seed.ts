import { performance } from 'node:perf_hooks';
import { sequelize } from './db';

// A realistic TaskFlow tasks table - 1,000,000 rows.
// The status distribution is deliberately uneven (as in reality): most tasks get finished.
//   done 70% · todo 22% · doing 7% · blocked 1%
// This unevenness is the core of the lab's selectivity step (5).
export const TASKS = 1_000_000;
export const PROJECTS = 2_000;
export const USERS = 5_000;

async function main(): Promise<void> {
	const started = performance.now();

	await sequelize.query('DROP TABLE IF EXISTS tasks');
	// The schema is in raw SQL, because in this lab we add and remove indexes by hand -
	// so Sequelize's sync must not add anything by itself.
	await sequelize.query(`
		CREATE TABLE tasks (
			id          serial PRIMARY KEY,
			"projectId" integer NOT NULL,
			"assigneeId" integer,
			title       text NOT NULL,
			status      text NOT NULL CHECK (status IN ('todo', 'doing', 'blocked', 'done')),
			"createdAt" timestamptz NOT NULL
		)
	`);

	// seeding with generate_series - building 1,000,000 rows as JS objects would be much slower.
	// setseed() fixes random(), so the same data is produced every time.
	await sequelize.query(`
		SELECT setseed(0.42);
		INSERT INTO tasks ("projectId", "assigneeId", title, status, "createdAt")
		SELECT
			1 + (g % ${PROJECTS}),
			CASE WHEN g % 20 = 0 THEN NULL ELSE 1 + ((g * 7) % ${USERS}) END,
			CASE WHEN g % 20 = 3 THEN 'Fix bug #' || g ELSE 'Task #' || g END,
			CASE
				WHEN r < 0.70 THEN 'done'
				WHEN r < 0.92 THEN 'todo'
				WHEN r < 0.99 THEN 'doing'
				ELSE 'blocked'
			END,
			timestamptz '2026-09-25 00:00:00+00' - (g * interval '63 seconds')
		FROM (SELECT g, random() AS r FROM generate_series(1, ${TASKS}) g) s
	`);

	// VACUUM: builds the visibility map - without it Postgres cannot do an "Index Only Scan"
	// (step 6 of the lab). ANALYZE: statistics for the planner (step 5).
	await sequelize.query('VACUUM ANALYZE tasks');

	const seconds = ((performance.now() - started) / 1000).toFixed(1);
	console.log(`\n  seeded ${TASKS.toLocaleString('en-US')} tasks in ${seconds}s\n`);
	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('seed failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
