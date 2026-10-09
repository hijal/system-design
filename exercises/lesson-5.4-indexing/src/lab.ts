import { Op, QueryTypes } from 'sequelize';
import { z } from 'zod';
import { dropSecondaryIndexes, sequelize } from './db';
import { explain } from './explain';

// Lesson 5.4 - the same query, different indexes, and what Postgres's planner decides.
// Every variant starts by dropping every index except the primary key, then adds only that variant's index.

type Variant = {
	label: string;
	sql: string;
	// the index-building work - mostly with queryInterface.addIndex, exactly the way it is written
	// in a Sequelize migration. What addIndex can't express is raw SQL.
	setup: () => Promise<void>;
	sizeOf?: string; // which index to show the size of
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
		title: '1. "My open tasks" - an index on the foreign key',
		note: 'Postgres does not create an index on a foreign key by itself (Lesson 5.2)',
		variants: [
			{ label: 'no index', sql: OPEN_TASKS, setup: none },
			{
				label: '(assigneeId)',
				sql: OPEN_TASKS,
				setup: () => qi.addIndex('tasks', { fields: ['assigneeId'], name: 'tasks_assignee' }),
				sizeOf: 'tasks_assignee'
			},
			{
				label: '(assigneeId) WHERE status <> done',
				sql: OPEN_TASKS,
				// Partial index - only the open tasks are in the index; the 70% "done" rows are left out
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
		title: '2. Project feed - column order in a composite index',
		note: 'WHERE projectId = 7 ORDER BY createdAt DESC LIMIT 20',
		variants: [
			{ label: 'no index', sql: FEED, setup: none },
			{
				label: '(projectId)',
				sql: FEED,
				setup: () => qi.addIndex('tasks', { fields: ['projectId'], name: 'tasks_project' })
			},
			{
				label: '(createdAt, projectId) - reversed',
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
		title: '3. Leftmost prefix - the second column of a composite index alone',
		note: 'filtering only by createdAt, without projectId',
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
		title: '4. A function on the column - the index exists but does not help',
		note: 'both queries ask the same question; the index is the same',
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
				label: '(lower(title)) - expression index',
				sql: `SELECT id FROM tasks WHERE lower(title) = 'fix bug #23'`,
				// Expression index - not among addIndex's typed options, so raw SQL (in a migration too)
				setup: async () => {
					await sequelize.query('CREATE INDEX tasks_title_lower ON tasks (lower(title))');
				}
			}
		]
	},
	{
		title: '5. Selectivity - the index exists, but Postgres does not use it',
		note: 'done = ~70% of rows, blocked = ~1% of rows; the same (status) index; id and title are needed, so it has to go to the table',
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
		title: '6. Covering index - the answer without going to the table',
		note: "step 2's feed query",
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
				// INCLUDE - not in the type of Sequelize v6's addIndex, so raw SQL
				setup: async () => {
					await sequelize.query(
						'CREATE INDEX tasks_project_created_cover ON tasks ("projectId", "createdAt") INCLUDE (id, title)'
					);
				}
			}
		]
	},
	{
		title: "7. LIKE - the B-tree's limit",
		note: 'there is an index on title',
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
				label: `(title text_pattern_ops) + same LIKE`,
				sql: `SELECT count(*) FROM tasks WHERE title LIKE 'Fix bug #1234%'`,
				// If the database collation is en_US.utf8, a plain B-tree can't serve LIKE 'abc%' -
				// it needs an index in byte-by-byte order with text_pattern_ops. An operator class, raw SQL.
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
	const only = process.argv[2]; // `npm run lab -- 4` runs only step 4
	for (const [i, step] of steps.entries()) {
		if (only && String(i + 1) !== only) continue;
		console.log(`\n${step.title}\n   (${step.note})`);
		console.log(row('index', 'plan', 'time', 'pages', ''));
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
