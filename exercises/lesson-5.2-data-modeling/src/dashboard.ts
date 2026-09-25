import { performance } from 'node:perf_hooks';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from './db';
import { Project } from './models/good';
import { reconcile } from './reconcile';

// Lesson 5.2 §১.৪ — denormalization এর লাভটা মেপে দেখা।
// একই প্রশ্ন দুইভাবে: (ক) প্রতিবার tasks table থেকে গুনে, (খ) projects.openTaskCount পড়ে।

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
	// ৪ লাখ row Sequelize এর bulkCreate দিয়ে ঢোকাতে অনেক সময় লাগে (প্রতিটা row একটা JS
	// object)। তাই seed টা Postgres এর generate_series দিয়ে — এটা শুধু test data বানানো।
	await sequelize.query(
		`INSERT INTO users (name, email)
		 SELECT 'User ' || g, 'user' || g || '@taskflow.app' FROM generate_series(1, ${USERS}) g`
	);
	await sequelize.query(
		`INSERT INTO projects (name) SELECT 'Project ' || lpad(g::text, 3, '0') FROM generate_series(1, ${PROJECTS}) g`
	);
	// Status: ~৬০% done, বাকিটা todo/doing। কিছু project কে ইচ্ছা করে বেশি ব্যস্ত বানানো
	// (id % 7 = 0 হলে done কম), যাতে "সবচেয়ে ব্যস্ত project" প্রশ্নের একটা অর্থ থাকে।
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

// (ক) Normalized, সরল query — প্রতিবার গুনে। Sequelize এর include + group + limit একসাথে
// জটিল SQL বানায়, তাই aggregate report এর জন্য raw SQL, আর ফলাফল Zod দিয়ে parse।
// ফাঁদ: LIMIT 20 থাকলেও Postgres আগে **সব** ৫০০ project এর count বানায়, তারপর ২০টা নেয়।
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

// (ক২) Normalized, ভালো করে লেখা — আগে ২০টা project বাছো, তারপর শুধু তাদের task গোনো।
// LATERAL মানে "বাম দিকের প্রতিটা row এর জন্য ডান দিকের subquery টা চালাও"।
// (projectId, status) index থাকায় প্রতিটা count শুধু index পড়েই হয়ে যায়।
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

// "সবচেয়ে ব্যস্ত" প্রশ্নে এই কৌশল কাজ করে না — কোন ১০টা সবচেয়ে ব্যস্ত সেটা জানতে হলে
// আগে সবগুলো গুনতেই হবে। Derived মান দিয়ে sort/filter — এখানেই denormalization এর আসল জায়গা।
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

// (খ) Denormalized — শুধু projects table পড়া, কোনো join বা count নেই
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
	for (let i = 0; i < 3; i++) await fn(); // warm-up — buffer pool গরম করা (Lesson 4.1)
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

	// আগে correctness — দ্রুত কিন্তু ভুল উত্তরের কোনো দাম নেই
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
	console.log('  প্রশ্ন                          গুনে (সরল)   গুনে (LATERAL)   counter পড়ে');
	console.log(`  ২০টা project এর পাতা           ${ms(pageA)}     ${ms(pageL)}      ${ms(pageB)}`);
	console.log(`  সবচেয়ে ব্যস্ত ১০টা project      ${ms(busyA)}          —          ${ms(busyB)}`);
	console.log(`\n  (median of ${ROUNDS} runs, Sequelize overhead সহ)\n`);

	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('dashboard failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
