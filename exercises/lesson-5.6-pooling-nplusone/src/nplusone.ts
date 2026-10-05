import { performance } from 'node:perf_hooks';
import { Op, QueryTypes } from 'sequelize';
import { z } from 'zod';
import { createSequelize } from './db';
import { Member, Project, Task, User, initModels } from './models';

// Lesson 5.6 — the same dashboard's data, fetched four ways:
// "the workspace's 50 projects, each one's tasks, each task's assignee's name"

const PROJECTS = 50;
const TASKS_PER_PROJECT = 20;
const MEMBERS_PER_PROJECT = 10;
const USERS = 200;
const ROUNDS = 5;

// counting every query — Sequelize's logging callback is called once for every SQL
const executed: string[] = [];
let counting = true; // off during the seed
const sequelize = createSequelize({ max: 10 }, (sql: string): void => {
	if (counting) executed.push(sql.replace(/^Executing \([^)]*\): /, ''));
});
initModels(sequelize);

type Row = { project: string; task: string; assignee: string };

// ── a. N+1 — code written "the natural way" ─────────────────────────────────
async function nPlusOne(): Promise<Row[]> {
	const rows: Row[] = [];
	const projects = await Project.findAll({ order: [['id', 'ASC']] }); // 1 query
	for (const project of projects) {
		const tasks = await Task.findAll({ where: { projectId: project.id }, order: [['id', 'ASC']] }); // N
		for (const task of tasks) {
			const assignee = await User.findByPk(task.assigneeId); // N×M more
			rows.push({ project: project.name, task: task.title, assignee: assignee?.name ?? '?' });
		}
	}
	return rows;
}

// ── b. include — one JOIN query ─────────────────────────────────────────────
async function eager(): Promise<Row[]> {
	const projects = await Project.findAll({
		include: [{ model: Task, as: 'tasks', include: [{ model: User, as: 'assignee' }] }],
		order: [
			['id', 'ASC'],
			[{ model: Task, as: 'tasks' }, 'id', 'ASC']
		]
	});
	return projects.flatMap((p) =>
		(p.tasks ?? []).map((t) => ({
			project: p.name,
			task: t.title,
			assignee: t.assignee?.name ?? '?'
		}))
	);
}

// ── c. Batching — one `IN (...)` query per level (the DataLoader idea) ──────
async function batched(): Promise<Row[]> {
	const projects = await Project.findAll({ order: [['id', 'ASC']] });
	const tasks = await Task.findAll({
		where: { projectId: { [Op.in]: projects.map((p) => p.id) } },
		order: [['id', 'ASC']]
	});
	const users = await User.findAll({
		where: { id: { [Op.in]: [...new Set(tasks.map((t) => t.assigneeId))] } }
	});
	const userName = new Map(users.map((u) => [u.id, u.name]));
	const projectName = new Map(projects.map((p) => [p.id, p.name]));
	return tasks.map((t) => ({
		project: projectName.get(t.projectId) ?? '?',
		task: t.title,
		assignee: userName.get(t.assigneeId) ?? '?'
	}));
}

// ── Cartesian explosion — two hasMany included together ─────────────────────
async function twoHasManyJoined(): Promise<number> {
	const projects = await Project.findAll({
		include: [
			{ model: Task, as: 'tasks' },
			{ model: Member, as: 'members' }
		]
	});
	return projects.length;
}

async function twoHasManySeparate(): Promise<number> {
	const projects = await Project.findAll({
		include: [
			{ model: Task, as: 'tasks', separate: true }, // separate query: WHERE projectId IN (...)
			{ model: Member, as: 'members', separate: true }
		]
	});
	return projects.length;
}

const countRow = z.array(z.object({ n: z.coerce.number() })).length(1);

// how many rows the database actually sent — counted by wrapping every executed SQL in count(*)
async function rowsReturned(sqls: string[]): Promise<number> {
	let total = 0;
	for (const sql of sqls) {
		const rows = countRow.parse(
			await sequelize.query(`SELECT count(*) AS n FROM (${sql.replace(/;\s*$/, '')}) q`, {
				type: QueryTypes.SELECT,
				logging: false
			})
		);
		total += rows[0]?.n ?? 0;
	}
	return total;
}

type Measured = { queries: number; rows: number; ms: number };

async function measure(fn: () => Promise<unknown>): Promise<Measured> {
	executed.length = 0;
	await fn();
	const sqls = [...executed];
	const rows = await rowsReturned(sqls);
	const samples: number[] = [];
	for (let i = 0; i < ROUNDS; i++) {
		const started = performance.now();
		await fn();
		samples.push(performance.now() - started);
	}
	samples.sort((a, b) => a - b);
	return { queries: sqls.length, rows, ms: samples[Math.floor(ROUNDS / 2)] ?? 0 };
}

async function seed(): Promise<void> {
	counting = false;
	await sequelize.sync({ force: true });
	await User.bulkCreate(Array.from({ length: USERS }, (_u, i) => ({ name: `User ${i + 1}` })));
	await Project.bulkCreate(
		Array.from({ length: PROJECTS }, (_p, i) => ({ name: `Project ${i + 1}` }))
	);
	await Task.bulkCreate(
		Array.from({ length: PROJECTS * TASKS_PER_PROJECT }, (_t, i) => ({
			title: `Task ${i + 1}`,
			projectId: 1 + Math.floor(i / TASKS_PER_PROJECT),
			assigneeId: 1 + (i % USERS)
		}))
	);
	await Member.bulkCreate(
		Array.from({ length: PROJECTS * MEMBERS_PER_PROJECT }, (_m, i) => ({
			projectId: 1 + Math.floor(i / MEMBERS_PER_PROJECT),
			userId: 1 + (i % USERS)
		}))
	);
	counting = true;
}

function line(label: string, m: Measured, projectedRttMs: number): string {
	const projected = m.ms + m.queries * projectedRttMs;
	return `   ${label.padEnd(30)} ${String(m.queries).padStart(6)} ${m.rows.toLocaleString('en-US').padStart(8)} ${m.ms.toFixed(1).padStart(9)} ms ${projected.toFixed(0).padStart(9)} ms`;
}

async function main(): Promise<void> {
	await seed();
	const RTT = 1; // in production the app and DB are on separate machines — calculated at ~1 ms per round trip

	// correctness first — whether all three give the same data
	const [a, b, c] = [await nPlusOne(), await eager(), await batched()];
	const same = JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c);
	console.log(
		`\n1. Dashboard: ${PROJECTS} projects → ${a.length} tasks → assignee names   (same result for all three? ${same})`
	);
	console.log(`   ${'approach'.padEnd(30)}queries     rows     measured   +${RTT} ms RTT*`);
	console.log(line('a. N+1 (findByPk in a loop)', await measure(nPlusOne), RTT));
	console.log(line('b. include (one JOIN)', await measure(eager), RTT));
	console.log(line('c. batching (3 with IN)', await measure(batched), RTT));

	console.log(
		`\n2. Two hasMany at once: project → tasks (${TASKS_PER_PROJECT}) + members (${MEMBERS_PER_PROJECT})`
	);
	console.log(`   ${'approach'.padEnd(30)}queries     rows     measured   +${RTT} ms RTT*`);
	console.log(line('include, one JOIN', await measure(twoHasManyJoined), RTT));
	console.log(line('include, separate: true', await measure(twoHasManySeparate), RTT));

	console.log(
		`\n   * measured time on this machine (DB on the same machine, round trip near zero). The last column is a calculation,`
	);
	console.log(
		`     not a measurement: measured time + query count × ${RTT} ms — what it would be with the app and DB on separate machines.\n`
	);
	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('nplusone failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
