import { performance } from 'node:perf_hooks';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from './db';
import { Project } from './models/good';
import { reconcile } from './reconcile';

// Lesson 5.2 §1.4 - measuring denormalization's benefit.
// The same question two ways: (a) counting from the tasks table every time, (b) reading projects.openTaskCount.

const PROJECTS = 500;
const TASKS_PER_PROJECT = 800;
const USERS = 1_000;
const ROUNDS = 30;

const countRows = z.array(
	z.object({ id: z.number(), name: z.string(), open: z.coerce.number().int() })
);
type CountRow = z.infer<typeof countRows>[number];

async function seed(): Promise<void> {
	await sequelize.sync({ force: true });
	// Inserting 400,000 rows with Sequelize's bulkCreate takes a long time (every row is a JS
	// object). So the seed uses Postgres's generate_series - this only builds test data.
	await sequelize.query(
		`INSERT INTO users (name, email)
		 SELECT 'User ' || g, 'user' || g || '@taskflow.app' FROM generate_series(1, ${USERS}) g`
	);
	await sequelize.query(
		`INSERT INTO projects (name) SELECT 'Project ' || lpad(g::text, 3, '0') FROM generate_series(1, ${PROJECTS}) g`
	);
	// Status: ~60% done, the rest todo/doing. Some projects are made busier on purpose
	// (fewer done when id % 7 = 0), so the "busiest project" question means something.
	await sequelize.query(
		`INSERT INTO tasks (title, status, "projectId", "assigneeId")
		 SELECT 'Task ' || t,
		        (CASE
		           WHEN random() < (CASE WHEN p % 7 = 0 THEN 0.2 ELSE 0.6 END) THEN 'done'
		           WHEN random() < 0.6 THEN 'todo'
		           ELSE 'doing'
		         END)::"enum_tasks_status",
		        p,
		        1 + (t % ${USERS})
		 FROM generate_series(1, ${PROJECTS}) p, generate_series(1, ${TASKS_PER_PROJECT}) t`
	);
	await reconcile();
	await sequelize.query('ANALYZE');
}

// (a) Normalized, a plain query - counting every time. Sequelize's include + group + limit together
// build complicated SQL, so raw SQL for the aggregate report, with the result parsed by Zod.
// The trap: even with LIMIT 20, Postgres first builds the count for **all** 500 projects, then takes 20.
async function pageComputed(): Promise<CountRow[]> {
	return countRows.parse(
		await sequelize.query(
			`SELECT p.id, p.name, count(t.id) AS open
			 FROM projects p
			 LEFT JOIN tasks t ON t."projectId" = p.id AND t.status <> 'done'
			 GROUP BY p.id ORDER BY p.name LIMIT 20`,
			{ type: QueryTypes.SELECT }
		)
	);
}

// (a2) Normalized, written well - pick 20 projects first, then count only their tasks.
// LATERAL means "for every row on the left, run the subquery on the right".
// With the (projectId, status) index every count is done by reading the index alone.
async function pageComputedLateral(): Promise<CountRow[]> {
	return countRows.parse(
		await sequelize.query(
			`SELECT p.id, p.name, c.open
			 FROM (SELECT id, name FROM projects ORDER BY name LIMIT 20) p
			 CROSS JOIN LATERAL (
			   SELECT count(*) AS open FROM tasks t
			   WHERE t."projectId" = p.id AND t.status <> 'done'
			 ) c
			 ORDER BY p.name`,
			{ type: QueryTypes.SELECT }
		)
	);
}

// This trick does not work for the "busiest" question - to know which 10 are busiest
// you have to count them all first. Sorting/filtering by a derived value - that is denormalization's real place.
async function busiestComputed(): Promise<CountRow[]> {
	return countRows.parse(
		await sequelize.query(
			`SELECT p.id, p.name, count(t.id) AS open
			 FROM projects p
			 LEFT JOIN tasks t ON t."projectId" = p.id AND t.status <> 'done'
			 GROUP BY p.id ORDER BY open DESC, p.id LIMIT 10`,
			{ type: QueryTypes.SELECT }
		)
	);
}

// (b) Denormalized - reading only the projects table, no join or count
async function pageStored(): Promise<CountRow[]> {
	const rows = await Project.findAll({ order: [['name', 'ASC']], limit: 20 });
	return rows.map((p) => ({ id: p.id, name: p.name, open: p.openTaskCount }));
}

async function busiestStored(): Promise<CountRow[]> {
	const rows = await Project.findAll({
		order: [
			['openTaskCount', 'DESC'],
			['id', 'ASC']
		],
		limit: 10
	});
	return rows.map((p) => ({ id: p.id, name: p.name, open: p.openTaskCount }));
}

async function medianMs(fn: () => Promise<CountRow[]>): Promise<number> {
	for (let i = 0; i < 3; i++) await fn(); // warm-up - warming the buffer pool (Lesson 4.1)
	const samples: number[] = [];
	for (let i = 0; i < ROUNDS; i++) {
		const started = performance.now();
		await fn();
		samples.push(performance.now() - started);
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)] ?? 0;
}

function sameResult(a: CountRow[], b: CountRow[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

async function main(): Promise<void> {
	const seedStarted = performance.now();
	await seed();
	console.log(
		`\n  seeded         : ${PROJECTS} projects × ${TASKS_PER_PROJECT} tasks = ${(PROJECTS * TASKS_PER_PROJECT).toLocaleString('en-US')} tasks (${((performance.now() - seedStarted) / 1000).toFixed(1)}s)`
	);

	// correctness first - a fast but wrong answer is worth nothing
	const pageStoredRows = await pageStored();
	const pageSame =
		sameResult(await pageComputed(), pageStoredRows) &&
		sameResult(await pageComputedLateral(), pageStoredRows);
	const busiestSame = sameResult(await busiestComputed(), await busiestStored());
	console.log(`  results match  : page=${pageSame}, busiest=${busiestSame}\n`);

	const pageA = await medianMs(pageComputed);
	const pageL = await medianMs(pageComputedLateral);
	const pageB = await medianMs(pageStored);
	const busyA = await medianMs(busiestComputed);
	const busyB = await medianMs(busiestStored);

	const ms = (n: number): string => `${n.toFixed(2).padStart(7)} ms`;
	console.log('  question                     counted (simple)   counted (LATERAL)   read counter');
	console.log(
		`  page of 20 projects                ${ms(pageA)}          ${ms(pageL)}     ${ms(pageB)}`
	);
	console.log(
		`  10 busiest projects                ${ms(busyA)}                -        ${ms(busyB)}`
	);
	console.log(`\n  (median of ${ROUNDS} runs, including Sequelize overhead)\n`);

	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('dashboard failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
