import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { mulberry32, ms, pad, percentile } from './random';

// Lesson 9.1 §1.4 — when one transaction is split across two services.
//
// "Create task" means two things: a row in the tasks table, and task_count + 1 in billing's workspace (the plan's
// limit and the bill come from this number). The two must always match.
//   monolith  — the same database, one transaction (BEGIN … COMMIT)
//   services  — tasks_svc and billing_svc, two separate databases (database per service); no transaction
//               touches both, so they are two separate writes — which goes first has to be chosen
// On each operation, with probability CRASH_RATE the process dies after the first write (deploy, OOM, timeout).
// Which operations crash is seeded — exactly the same operations on all four paths.

const cfg = z
	.object({
		DATABASE_URL: z.string().default('postgres://taskflow:taskflow@localhost:5447'),
		OPS: z.coerce.number().int().positive().default(3000),
		WORKSPACES: z.coerce.number().int().positive().default(100),
		CRASH_RATE: z.coerce.number().min(0).max(1).default(0.03),
		CONCURRENCY: z.coerce.number().int().positive().default(8),
		SEED: z.coerce.number().int().default(7)
	})
	.parse(process.env);

const pool = (db: string): Pool =>
	new Pool({ connectionString: `${cfg.DATABASE_URL}/${db}`, max: cfg.CONCURRENCY });

class Crash extends Error {
	override readonly name = 'Crash';
}

async function setup(): Promise<void> {
	const admin = pool('taskflow');
	try {
		await admin.query('SELECT 1');
	} catch {
		console.error('Postgres cannot be reached — run `docker compose up -d --wait` first.');
		process.exit(1);
	}
	for (const db of ['tasks_svc', 'billing_svc']) {
		const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
		if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${db}`);
	}
	await admin.end();
}

async function reset(): Promise<void> {
	const seed = `INSERT INTO workspaces (id, plan) SELECT g, CASE WHEN g % 3 = 0 THEN 'pro' ELSE 'free' END FROM generate_series(1, ${cfg.WORKSPACES}) g`;
	const mono = pool('taskflow');
	await mono.query(`
		DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS workspaces;
		CREATE TABLE workspaces (id int PRIMARY KEY, plan text NOT NULL, task_count int NOT NULL DEFAULT 0);
		CREATE TABLE tasks (id bigserial PRIMARY KEY, workspace_id int NOT NULL REFERENCES workspaces, title text NOT NULL);
		${seed};`);
	await mono.end();
	const tasks = pool('tasks_svc');
	// no FOREIGN KEY to the workspace is possible — workspaces are in another database
	await tasks.query(`
		DROP TABLE IF EXISTS tasks;
		CREATE TABLE tasks (id bigserial PRIMARY KEY, workspace_id int NOT NULL, title text NOT NULL);`);
	await tasks.end();
	const billing = pool('billing_svc');
	await billing.query(`
		DROP TABLE IF EXISTS workspaces;
		CREATE TABLE workspaces (id int PRIMARY KEY, plan text NOT NULL, task_count int NOT NULL DEFAULT 0);
		${seed};`);
	await billing.end();
}

type Op = { i: number; workspaceId: number; title: string; crash: boolean };
type Path = {
	name: string;
	retry: boolean; // after a crash the user tries again (without a crash this time)
	run: (op: Op, crashNow: boolean) => Promise<void>;
	close: () => Promise<void>;
	count: () => Promise<{ tasks: Map<number, number>; counters: Map<number, number> }>;
};

const insertTask = 'INSERT INTO tasks (workspace_id, title) VALUES ($1, $2)';
const bumpCounter = 'UPDATE workspaces SET task_count = task_count + 1 WHERE id = $1';

const byWorkspace = (rows: { id: number; n: number }[]): Map<number, number> =>
	new Map(rows.map((r) => [r.id, r.n]));
const countRow = z.object({ id: z.number(), n: z.coerce.number() });

async function tasksPer(p: Pool): Promise<Map<number, number>> {
	const r = await p.query('SELECT workspace_id AS id, count(*) AS n FROM tasks GROUP BY 1');
	return byWorkspace(z.array(countRow).parse(r.rows));
}
async function countersIn(p: Pool): Promise<Map<number, number>> {
	const r = await p.query('SELECT id, task_count AS n FROM workspaces');
	return byWorkspace(z.array(countRow).parse(r.rows));
}

function monolithPath(): Path {
	const db = pool('taskflow');
	return {
		name: 'monolith: one transaction',
		retry: false,
		async run(op, crashNow) {
			const client: PoolClient = await db.connect();
			try {
				await client.query('BEGIN');
				await client.query(insertTask, [op.workspaceId, op.title]);
				if (crashNow) throw new Crash();
				await client.query(bumpCounter, [op.workspaceId]);
				await client.query('COMMIT');
			} catch (error: unknown) {
				// in a real crash the connection drops and Postgres itself ROLLs BACK — done by hand here
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
		},
		close: () => db.end(),
		count: async () => ({ tasks: await tasksPer(db), counters: await countersIn(db) })
	};
}

function servicesPath(order: 'task-first' | 'counter-first', retry: boolean): Path {
	const tasks = pool('tasks_svc');
	const billing = pool('billing_svc');
	const writeTask = (op: Op) => tasks.query(insertTask, [op.workspaceId, op.title]);
	const writeCounter = (op: Op) => billing.query(bumpCounter, [op.workspaceId]);
	const [first, second] =
		order === 'task-first' ? [writeTask, writeCounter] : [writeCounter, writeTask];
	return {
		name: retry
			? 'services: task first + the user retried'
			: order === 'task-first'
				? 'services: task first, then billing'
				: 'services: billing first, then task',
		retry,
		async run(op, crashNow) {
			await first(op); // this write commits on its own — and can't be undone
			if (crashNow) throw new Crash();
			await second(op);
		},
		close: async () => {
			await tasks.end();
			await billing.end();
		},
		count: async () => ({ tasks: await tasksPer(tasks), counters: await countersIn(billing) })
	};
}

async function runPath(path: Path, ops: Op[]): Promise<void> {
	await reset();
	let next = 0;
	let succeeded = 0;
	let failed = 0;
	const latencies: number[] = [];
	const began = performance.now();
	const worker = async (): Promise<void> => {
		for (let op = ops[next++]; op; op = ops[next++]) {
			const t = performance.now();
			try {
				await path.run(op, op.crash);
				succeeded++;
			} catch (error: unknown) {
				if (!(error instanceof Crash)) throw error;
				if (path.retry) {
					await path.run(op, false); // the user pressed "try again" — they don't know what happened to the first attempt
					succeeded++;
				} else failed++;
			}
			latencies.push(performance.now() - t);
		}
	};
	await Promise.all(Array.from({ length: cfg.CONCURRENCY }, worker));
	const elapsed = performance.now() - began;

	const { tasks, counters } = await path.count();
	let taskRows = 0;
	let counterSum = 0;
	let mismatched = 0;
	for (let w = 1; w <= cfg.WORKSPACES; w++) {
		const t = tasks.get(w) ?? 0;
		const c = counters.get(w) ?? 0;
		taskRows += t;
		counterSum += c;
		if (t !== c) mismatched++;
	}
	const diff = counterSum - taskRows;
	const verdict =
		diff === 0 && mismatched === 0
			? 'they match'
			: diff < 0
				? `${-diff} tasks with no bill`
				: `${diff} bills with no task`;
	console.log(
		`   ${path.name.padEnd(46)} ${pad(succeeded, 6)} ${pad(failed, 6)} ${pad(taskRows, 8)} ${pad(counterSum, 8)} ${pad(mismatched, 9)}   ${verdict.padEnd(22)} ${pad(((ops.length / elapsed) * 1000).toFixed(0), 6)} ${pad(ms(percentile(latencies, 50)), 8)}`
	);
	await path.close();
}

async function main(): Promise<void> {
	await setup();
	const ops: Op[] = Array.from({ length: cfg.OPS }, (_, i) => ({
		i,
		workspaceId: ((i * 31) % cfg.WORKSPACES) + 1,
		title: `Task ${i + 1}`,
		crash: mulberry32(cfg.SEED * 100_003 + i)() < cfg.CRASH_RATE
	}));
	const crashes = ops.filter((o) => o.crash).length;
	console.log(
		`\n── ${cfg.OPS} "create task", ${cfg.WORKSPACES} workspaces, crash after the first write in ${crashes} of them (${(cfg.CRASH_RATE * 100).toFixed(0)}%), ${cfg.CONCURRENCY} concurrent ──`
	);
	console.log(
		'   path                                               ok failed    tasks  counter    bad ws   result                  ops/s      p50'
	);
	for (const path of [
		monolithPath(),
		servicesPath('task-first', false),
		servicesPath('counter-first', false),
		servicesPath('task-first', true)
	])
		await runPath(path, ops);
	console.log(
		'\n   (in the monolith a crash cancels the whole transaction — the user sees an error, but nothing is left half-done.)\n'
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
