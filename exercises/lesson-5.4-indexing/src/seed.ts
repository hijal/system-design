import { performance } from 'node:perf_hooks';
import { sequelize } from './db';

// TaskFlow এর একটা বাস্তবসম্মত tasks table — ১০ লাখ row।
// Status এর বণ্টন ইচ্ছা করে অসমান (বাস্তবেও তাই): বেশিরভাগ task শেষ হয়ে যায়।
//   done 70% · todo 22% · doing 7% · blocked 1%
// এই অসমতাটাই Lab এর selectivity ধাপের (৫) মূল।
export const TASKS = 1_000_000;
export const PROJECTS = 2_000;
export const USERS = 5_000;

async function main(): Promise<void> {
	const started = performance.now();

	await sequelize.query('DROP TABLE IF EXISTS tasks');
	// Schema টা raw SQL এ, কারণ এই lab এ আমরা index নিজের হাতে যোগ-বিয়োগ করব —
	// Sequelize এর sync যেন নিজে থেকে কিছু যোগ না করে।
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

	// generate_series দিয়ে seed — ১০ লাখ row JS object হিসেবে বানালে অনেক ধীর হতো।
	// setseed() দিয়ে random() কে নির্দিষ্ট করা, যাতে প্রতিবার একই data তৈরি হয়।
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

	// VACUUM: visibility map তৈরি করে — এটা ছাড়া Postgres "Index Only Scan" করতে পারে না
	// (Lab এর ধাপ ৬)। ANALYZE: planner এর জন্য statistics (ধাপ ৫)।
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
