import { performance } from 'node:perf_hooks';
import { createSequelize } from './db';
import { Task, initModels } from './models';

// Lesson 5.6 §1.6 — the cost after the data comes back from the database.
// Sequelize turns every row into a full Model instance (getters/setters, change
// tracking, and so on) — this is called hydration. With few rows it isn't noticeable; with many it is.

const ROWS = 100_000;
const ROUNDS = 5;

const sequelize = createSequelize();
initModels(sequelize);

async function seed(): Promise<void> {
	await sequelize.sync({ force: true });
	await sequelize.query(
		`INSERT INTO users (name) SELECT 'User ' || g FROM generate_series(1, 100) g`
	);
	await sequelize.query(
		`INSERT INTO projects (name) SELECT 'Project ' || g FROM generate_series(1, 100) g`
	);
	await sequelize.query(
		`INSERT INTO tasks (title, "projectId", "assigneeId")
		 SELECT 'Task #' || g || ' — ' || repeat('lorem ipsum ', 5), 1 + g % 100, 1 + g % 100
		 FROM generate_series(1, ${ROWS}) g`
	);
}

async function median(fn: () => Promise<number>): Promise<{ ms: number; count: number }> {
	let count = await fn(); // warm-up
	const samples: number[] = [];
	for (let i = 0; i < ROUNDS; i++) {
		const started = performance.now();
		count = await fn();
		samples.push(performance.now() - started);
	}
	samples.sort((a, b) => a - b);
	return { ms: samples[Math.floor(ROUNDS / 2)] ?? 0, count };
}

async function main(): Promise<void> {
	await seed();
	console.log(
		`\nHydration: reading ${ROWS.toLocaleString('en-US')} tasks — the same query, returned in different shapes`
	);

	const variants: [string, () => Promise<number>][] = [
		['Model instance (default)', async () => (await Task.findAll()).length],
		['raw: true', async () => (await Task.findAll({ raw: true })).length],
		[
			'raw: true + only needed columns',
			async () => (await Task.findAll({ attributes: ['id', 'title'], raw: true })).length
		]
	];

	let base: number | undefined;
	for (const [label, fn] of variants) {
		const { ms, count } = await median(fn);
		base ??= ms;
		console.log(
			`   ${label.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms   (${count.toLocaleString('en-US')} rows, ${(base / ms).toFixed(1)}x)`
		);
	}
	console.log('');
	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('hydration failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
