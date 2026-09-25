import { Op, QueryTypes } from 'sequelize';
import { z } from 'zod';
import { dropSecondaryIndexes, sequelize } from './db';
import { explain } from './explain';

// Lesson 5.4 — একই query, ভিন্ন ভিন্ন index, আর Postgres এর planner কী সিদ্ধান্ত নেয়।
// প্রতিটা variant শুরু হয় primary key ছাড়া সব index মুছে, তারপর শুধু সেই variant এর index।

type Variant = {
	label: string;
	sql: string;
	// index তৈরির কাজ — বেশিরভাগ queryInterface.addIndex দিয়ে, ঠিক যেভাবে একটা
	// Sequelize migration এ লেখা হয়। যেগুলো addIndex এ প্রকাশ করা যায় না, সেগুলো raw SQL।
	setup: () => Promise<void>;
	sizeOf?: string; // কোন index এর আকার দেখাতে হবে
};

type Step = { title: string; note: string; variants: Variant[] };

const qi = sequelize.getQueryInterface();
const none = async (): Promise<void> => {};

const sizeRows = z.array(z.object({ size: z.string() }));

async function indexSize(name: string): Promise<string> {
	const rows = sizeRows.parse(
		await sequelize.query(`SELECT pg_size_pretty(pg_relation_size(:name)) AS size`, {
			replacements: { name },
			type: QueryTypes.SELECT
		})
	);
	return rows[0]?.size ?? '?';
}

const OPEN_TASKS = `SELECT id, title, status FROM tasks WHERE "assigneeId" = 42 AND status <> 'done'`;
const FEED = `SELECT id, title, "createdAt" FROM tasks WHERE "projectId" = 7 ORDER BY "createdAt" DESC LIMIT 20`;

const steps: Step[] = [
	{
		title: '১. "আমার খোলা task" — foreign key এ index',
		note: 'Postgres foreign key এ নিজে index বানায় না (Lesson 5.2)',
		variants: [
			{ label: 'index নেই', sql: OPEN_TASKS, setup: none },
			{
				label: '(assigneeId)',
				sql: OPEN_TASKS,
				setup: () => qi.addIndex('tasks', { fields: ['assigneeId'], name: 'tasks_assignee' }),
				sizeOf: 'tasks_assignee'
			},
			{
				label: '(assigneeId) WHERE status <> done',
				sql: OPEN_TASKS,
				// Partial index — শুধু খোলা task গুলো index এ; ৭০% "done" row বাদ
				setup: () =>
					qi.addIndex('tasks', {
						fields: ['assigneeId'],
						name: 'tasks_assignee_open',
						where: { status: { [Op.ne]: 'done' } }
					}),
				sizeOf: 'tasks_assignee_open'
			}
		]
	},
	{
		title: '২. Project feed — composite index এ column এর ক্রম',
		note: 'WHERE projectId = 7 ORDER BY createdAt DESC LIMIT 20',
		variants: [
			{ label: 'index নেই', sql: FEED, setup: none },
			{
				label: '(projectId)',
				sql: FEED,
				setup: () => qi.addIndex('tasks', { fields: ['projectId'], name: 'tasks_project' })
			},
			{
				label: '(createdAt, projectId) — উল্টো',
				sql: FEED,
				setup: () =>
					qi.addIndex('tasks', {
						fields: ['createdAt', 'projectId'],
						name: 'tasks_created_project'
					})
			},
			{
				label: '(projectId, createdAt)',
				sql: FEED,
				setup: () =>
					qi.addIndex('tasks', {
						fields: ['projectId', 'createdAt'],
						name: 'tasks_project_created'
					})
			}
		]
	},
	{
		title: '৩. Leftmost prefix — composite index এর দ্বিতীয় column একা',
		note: 'শুধু createdAt দিয়ে filter, projectId ছাড়া',
		variants: [
			{
				label: '(projectId, createdAt)',
				sql: `SELECT count(*) FROM tasks WHERE "createdAt" >= '2026-09-24'`,
				setup: () =>
					qi.addIndex('tasks', {
						fields: ['projectId', 'createdAt'],
						name: 'tasks_project_created'
					})
			},
			{
				label: '(createdAt)',
				sql: `SELECT count(*) FROM tasks WHERE "createdAt" >= '2026-09-24'`,
				setup: () => qi.addIndex('tasks', { fields: ['createdAt'], name: 'tasks_created' })
			}
		]
	},
	{
		title: '৪. Column এর উপর function — index থাকলেও কাজে লাগে না',
		note: 'দুটো query একই প্রশ্ন করছে; index একই',
		variants: [
			{
				label: '(createdAt) + createdAt::date = …',
				sql: `SELECT count(*) FROM tasks WHERE "createdAt"::date = '2026-09-01'`,
				setup: () => qi.addIndex('tasks', { fields: ['createdAt'], name: 'tasks_created' })
			},
			{
				label: '(createdAt) + range',
				sql: `SELECT count(*) FROM tasks WHERE "createdAt" >= '2026-09-01' AND "createdAt" < '2026-09-02'`,
				setup: () => qi.addIndex('tasks', { fields: ['createdAt'], name: 'tasks_created' })
			},
			{
				label: '(title) + lower(title) = …',
				sql: `SELECT id FROM tasks WHERE lower(title) = 'fix bug #23'`,
				setup: () => qi.addIndex('tasks', { fields: ['title'], name: 'tasks_title' })
			},
			{
				label: '(lower(title)) — expression index',
				sql: `SELECT id FROM tasks WHERE lower(title) = 'fix bug #23'`,
				// Expression index — addIndex এর typed option এ নেই, তাই raw SQL (migration এও তাই)
				setup: async () => {
					await sequelize.query('CREATE INDEX tasks_title_lower ON tasks (lower(title))');
				}
			}
		]
	},
	{
		title: '৫. Selectivity — index আছে, তবু Postgres নেয় না',
		note: 'done = ~৭০% row, blocked = ~১% row; একই (status) index; id আর title লাগবে, তাই table এ যেতেই হবে',
		variants: [
			{
				label: `(status) + status = 'done'`,
				sql: `SELECT id, title FROM tasks WHERE status = 'done'`,
				setup: () => qi.addIndex('tasks', { fields: ['status'], name: 'tasks_status' })
			},
			{
				label: `(status) + status = 'blocked'`,
				sql: `SELECT id, title FROM tasks WHERE status = 'blocked'`,
				setup: () => qi.addIndex('tasks', { fields: ['status'], name: 'tasks_status' })
			}
		]
	},
	{
		title: '৬. Covering index — table এ না গিয়েই উত্তর',
		note: 'ধাপ ২ এর feed query',
		variants: [
			{
				label: '(projectId, createdAt)',
				sql: FEED,
				setup: () =>
					qi.addIndex('tasks', {
						fields: ['projectId', 'createdAt'],
						name: 'tasks_project_created'
					})
			},
			{
				label: '(projectId, createdAt) INCLUDE (id, title)',
				sql: FEED,
				// INCLUDE — Sequelize v6 এর addIndex এর type এ নেই, তাই raw SQL
				setup: async () => {
					await sequelize.query(
						'CREATE INDEX tasks_project_created_cover ON tasks ("projectId", "createdAt") INCLUDE (id, title)'
					);
				}
			}
		]
	},
	{
		title: '৭. LIKE — B-tree এর সীমা',
		note: 'title এ index আছে',
		variants: [
			{
				label: `(title) + LIKE '%bug%'`,
				sql: `SELECT count(*) FROM tasks WHERE title LIKE '%bug%'`,
				setup: () => qi.addIndex('tasks', { fields: ['title'], name: 'tasks_title' })
			},
			{
				label: `(title) + LIKE 'Fix bug #1234%'`,
				sql: `SELECT count(*) FROM tasks WHERE title LIKE 'Fix bug #1234%'`,
				setup: () => qi.addIndex('tasks', { fields: ['title'], name: 'tasks_title' })
			},
			{
				label: `(title text_pattern_ops) + একই LIKE`,
				sql: `SELECT count(*) FROM tasks WHERE title LIKE 'Fix bug #1234%'`,
				// Database এর collation en_US.utf8 হলে সাধারণ B-tree দিয়ে LIKE 'abc%' চলে না —
				// text_pattern_ops দিয়ে byte-by-byte ক্রমে index লাগে। Operator class, raw SQL।
				setup: async () => {
					await sequelize.query(
						'CREATE INDEX tasks_title_pattern ON tasks (title text_pattern_ops)'
					);
				}
			}
		]
	}
];

function row(label: string, shape: string, ms: string, pages: string, extra: string): string {
	return `   ${label.padEnd(44)} ${ms.padStart(10)} ${pages.padStart(8)}  ${shape}${extra}`;
}

async function main(): Promise<void> {
	const only = process.argv[2]; // `npm run lab -- 4` দিলে শুধু ধাপ ৪
	for (const [i, step] of steps.entries()) {
		if (only && String(i + 1) !== only) continue;
		console.log(`\n${step.title}\n   (${step.note})`);
		console.log(row('index', 'plan', 'সময়', 'pages', ''));
		for (const variant of step.variants) {
			await dropSecondaryIndexes();
			await variant.setup();
			await sequelize.query('ANALYZE tasks');
			const result = await explain(variant.sql);
			const size = variant.sizeOf ? `  (index: ${await indexSize(variant.sizeOf)})` : '';
			console.log(
				row(
					variant.label,
					result.shape,
					`${result.ms.toFixed(2)} ms`,
					result.pages.toLocaleString('en-US'),
					size
				)
			);
		}
	}
	await dropSecondaryIndexes();
	console.log('');
	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('lab failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
