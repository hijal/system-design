import { Pool } from 'pg';
import { z } from 'zod';

// The part shared by both scripts: the database connections, pretending to crash, and checking "do the tasks and counter match".

export type DbName = 'taskflow' | 'tasks_svc' | 'billing_svc';

const url = z
	.string()
	.default('postgres://taskflow:taskflow@localhost:5448')
	.parse(process.env['DATABASE_URL']);

export const pool = (db: DbName, max: number): Pool =>
	new Pool({ connectionString: `${url}/${db}`, max });

// Pretending the process dies - deploy, OOM, timeout. Which operation it happens on is seeded.
export class Crash extends Error {
	override readonly name = 'Crash';
}

const setting = z.object({ max_prepared_transactions: z.coerce.number() });

export async function ensureDatabases(): Promise<void> {
	const admin = pool('taskflow', 1);
	try {
		await admin.query('SELECT 1');
	} catch {
		console.error('Postgres cannot be reached - run `docker compose up -d --wait` first.');
		process.exit(1);
	}
	const r = await admin.query('SHOW max_prepared_transactions');
	if (setting.parse(r.rows[0]).max_prepared_transactions < 64) {
		console.error(
			"max_prepared_transactions is too small - run Postgres with this repo's docker-compose.yml (the setting is in command)."
		);
		process.exit(1);
	}
	for (const db of ['tasks_svc', 'billing_svc']) {
		const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
		if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${db}`);
	}
	await admin.end();
}

const gidRow = z.object({ gid: z.string() });

// Throw away prepared transactions from an earlier run (or one stopped with Ctrl+C) - otherwise they
// hold row locks, and the next DROP TABLE waits forever. ROLLBACK PREPARED has to run connected to the
// database where the transaction was prepared.
export async function clearPrepared(): Promise<void> {
	for (const db of ['taskflow', 'tasks_svc', 'billing_svc'] as const) {
		const p = pool(db, 1);
		const r = await p.query(
			'SELECT gid FROM pg_prepared_xacts WHERE database = current_database()'
		);
		for (const { gid } of z.array(gidRow).parse(r.rows))
			await p.query(`ROLLBACK PREPARED '${gid}'`);
		await p.end();
	}
}

const countRow = z.object({ id: z.number(), n: z.coerce.number() });

// the SQL result: one number per workspace (id, n)
export async function perWorkspace(p: Pool, sql: string): Promise<Map<number, number>> {
	const r = await p.query(sql);
	return new Map(
		z
			.array(countRow)
			.parse(r.rows)
			.map((row) => [row.id, row.n])
	);
}

export const TASKS_PER_WS = 'SELECT workspace_id AS id, count(*) AS n FROM tasks GROUP BY 1';
export const COUNTER_PER_WS = 'SELECT id, task_count AS n FROM workspaces';

export type Tally = { taskRows: number; counterSum: number; mismatched: number };

// whether each workspace's task rows and billing counter match
export function tally(
	tasks: Map<number, number>,
	counters: Map<number, number>,
	workspaces: number
): Tally {
	const out: Tally = { taskRows: 0, counterSum: 0, mismatched: 0 };
	for (let w = 1; w <= workspaces; w++) {
		const t = tasks.get(w) ?? 0;
		const c = counters.get(w) ?? 0;
		out.taskRows += t;
		out.counterSum += c;
		if (t !== c) out.mismatched++;
	}
	return out;
}

export function verdict(t: Tally): string {
	const diff = t.counterSum - t.taskRows;
	if (diff === 0 && t.mismatched === 0) return 'they match';
	return diff < 0 ? `${-diff} tasks with no bill` : `${diff} bills with no task`;
}

// CONCURRENCY workers take jobs one at a time from a shared list
export async function runWorkers<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let item = items[next++]; item !== undefined; item = items[next++]) await fn(item);
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
}
