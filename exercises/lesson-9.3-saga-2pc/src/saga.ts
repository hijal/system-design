import type { Pool } from 'pg';
import { z } from 'zod';
import {
	COUNTER_PER_WS,
	Crash,
	TASKS_PER_WS,
	clearPrepared,
	ensureDatabases,
	perWorkspace,
	pool,
	runWorkers,
	tally,
	verdict
} from './db';
import { mulberry32, ms, pad, percentile, sleep } from './random';

// Lesson 9.3 §1.4–1.7 — Saga: every step a small local transaction in its own database, and on failure
// the reverse of the earlier steps (compensation).
//
// The "create task" saga — the orchestrator is the work service (tasks_svc), which keeps the saga's log in its own database:
//   1. billing.reserve  — task_count + 1 if within the workspace's limit (a reservation); otherwise "limit reached"
//   2. work.createTask  — fails if the project is archived (a business reason) → compensation: billing.release
//   a. crash (after writing to billing, before writing the log) and archived projects — without a saga, a saga, with recovery,
//      and what recovery does when the steps aren't idempotent
//   b. a saga has no isolation: many "create task" at once near the limit — what goes wrong under two rules

const cfg = z
	.object({
		OPS: z.coerce.number().int().positive().default(3000),
		WORKSPACES: z.coerce.number().int().positive().default(100),
		PROJECTS: z.coerce.number().int().positive().default(200),
		CRASH_RATE: z.coerce.number().min(0).max(1).default(0.03),
		ARCHIVED_RATE: z.coerce.number().min(0).max(1).default(0.02),
		CONCURRENCY: z.coerce.number().int().positive().default(8),
		SEED: z.coerce.number().int().default(7),
		NEAR_WORKSPACES: z.coerce.number().int().positive().default(50),
		LIMIT: z.coerce.number().int().positive().default(10),
		USED: z.coerce.number().int().min(0).default(8),
		ATTEMPTS: z.coerce.number().int().positive().default(4),
		NEAR_ARCHIVED_RATE: z.coerce.number().min(0).max(1).default(0.25),
		STEP_MS: z.coerce.number().min(0).default(20)
	})
	.parse(process.env);

type Op = { i: number; workspaceId: number; projectId: number; title: string; crash: boolean };

// ── database ──

async function reset(
	workspaces: number,
	limit: number,
	used: number,
	archived: (projectId: number) => boolean,
	projects: number
): Promise<void> {
	await clearPrepared();
	const work = pool('tasks_svc', 1);
	// sagas — the orchestrator's log: which step each saga is at. tasks.saga_id UNIQUE — the same saga can't create a task twice.
	await work.query(`
		DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS sagas; DROP TABLE IF EXISTS projects; DROP TABLE IF EXISTS twopc_log;
		CREATE TABLE projects (id int PRIMARY KEY, archived boolean NOT NULL);
		CREATE TABLE tasks (id bigserial PRIMARY KEY, workspace_id int NOT NULL, project_id int NOT NULL,
			title text NOT NULL, saga_id text UNIQUE);
		CREATE TABLE sagas (id text PRIMARY KEY, workspace_id int NOT NULL, project_id int NOT NULL,
			title text NOT NULL, state text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`);
	const ids = Array.from({ length: projects }, (_, k) => k + 1);
	await work.query(
		'INSERT INTO projects (id, archived) SELECT * FROM unnest($1::int[], $2::boolean[])',
		[ids, ids.map(archived)]
	);
	// pre-existing tasks (to sit near the limit) — project 0, not archived
	if (used > 0)
		await work.query(
			`INSERT INTO tasks (workspace_id, project_id, title)
			 SELECT w, 0, 'old' FROM generate_series(1, $1::int) w, generate_series(1, $2::int)`,
			[workspaces, used]
		);
	await work.end();
	const billing = pool('billing_svc', 1);
	// reservations — billing's own ledger: reservations for which saga, and their state. This is what makes reserve and release
	// idempotent — when the same saga_id comes a second time, the earlier answer.
	await billing.query(`
		DROP TABLE IF EXISTS workspaces; DROP TABLE IF EXISTS reservations;
		CREATE TABLE workspaces (id int PRIMARY KEY, plan text NOT NULL, task_limit int NOT NULL, task_count int NOT NULL);
		CREATE TABLE reservations (saga_id text PRIMARY KEY, workspace_id int NOT NULL, status text NOT NULL);`);
	await billing.query(
		`INSERT INTO workspaces (id, plan, task_limit, task_count)
		 SELECT g, 'free', $2::int, $3::int FROM generate_series(1, $1::int) g`,
		[workspaces, limit, used]
	);
	await billing.end();
}

type Services = { work: Pool; billing: Pool; idempotent: boolean; stepMs: number };

const services = (idempotent: boolean, stepMs: number, max: number): Services => ({
	work: pool('tasks_svc', max),
	billing: pool('billing_svc', max),
	idempotent,
	stepMs
});
const closeServices = async (s: Services): Promise<void> => {
	await s.work.end();
	await s.billing.end();
};

// ── billing service ──

const statusRow = z.object({ status: z.enum(['reserved', 'rejected', 'released']) });

// step 1: task_count + 1 if within the limit. The idempotent form: write to the ledger by saga_id — if the same saga comes
// again (recovery, retry) return the earlier answer, never count it twice.
async function reserve(
	s: Services,
	sagaId: string,
	workspaceId: number
): Promise<'reserved' | 'rejected'> {
	const bump =
		'UPDATE workspaces SET task_count = task_count + 1 WHERE id = $1 AND task_count < task_limit RETURNING id';
	if (!s.idempotent) {
		const r = await s.billing.query(bump, [workspaceId]);
		return r.rowCount === 1 ? 'reserved' : 'rejected';
	}
	const c = await s.billing.connect();
	try {
		await c.query('BEGIN');
		const prev = await c.query('SELECT status FROM reservations WHERE saga_id = $1', [sagaId]);
		const before = prev.rows[0];
		if (before !== undefined) {
			await c.query('COMMIT');
			return statusRow.parse(before).status === 'rejected' ? 'rejected' : 'reserved';
		}
		const r = await c.query(bump, [workspaceId]);
		const status = r.rowCount === 1 ? 'reserved' : 'rejected';
		await c.query('INSERT INTO reservations (saga_id, workspace_id, status) VALUES ($1, $2, $3)', [
			sagaId,
			workspaceId,
			status
		]);
		await c.query('COMMIT');
		return status;
	} catch (error: unknown) {
		await c.query('ROLLBACK');
		throw error;
	} finally {
		c.release();
	}
}

// Compensation: return the reservation. The idempotent form: only from 'reserved' to 'released' — called twice, it decreases once.
async function release(s: Services, sagaId: string, workspaceId: number): Promise<void> {
	if (!s.idempotent) {
		await s.billing.query('UPDATE workspaces SET task_count = task_count - 1 WHERE id = $1', [
			workspaceId
		]);
		return;
	}
	await s.billing.query(
		`WITH r AS (UPDATE reservations SET status = 'released' WHERE saga_id = $1 AND status = 'reserved' RETURNING workspace_id)
		 UPDATE workspaces w SET task_count = task_count - 1 FROM r WHERE w.id = r.workspace_id`,
		[sagaId]
	);
}

// ── work service ──

const archivedRow = z.object({ archived: z.boolean() });
type NewTask = { sagaId: string | null; workspaceId: number; projectId: number; title: string };

// step 2: create the task — and the saga's state 'done', in the same local transaction (work's own database).
async function createTask(s: Services, t: NewTask): Promise<'done' | 'archived'> {
	if (s.stepMs > 0) await sleep(s.stepMs); // the service's work and the network time
	const c = await s.work.connect();
	try {
		await c.query('BEGIN');
		const p = await c.query('SELECT archived FROM projects WHERE id = $1', [t.projectId]);
		if (archivedRow.parse(p.rows[0]).archived) {
			await c.query('ROLLBACK');
			return 'archived';
		}
		await c.query(
			`INSERT INTO tasks (workspace_id, project_id, title, saga_id) VALUES ($1, $2, $3, $4)
			 ${s.idempotent ? 'ON CONFLICT (saga_id) DO NOTHING' : ''}`,
			[t.workspaceId, t.projectId, t.title, s.idempotent ? t.sagaId : null]
		);
		if (t.sagaId !== null)
			await c.query("UPDATE sagas SET state = 'done', updated_at = now() WHERE id = $1", [
				t.sagaId
			]);
		await c.query('COMMIT');
		return 'done';
	} catch (error: unknown) {
		await c.query('ROLLBACK');
		throw error;
	} finally {
		c.release();
	}
}

// ── the orchestrator (inside the work service) ──

const states = ['started', 'reserved', 'done', 'compensating', 'compensated', 'rejected'] as const;
type SagaState = (typeof states)[number];
type Result = 'done' | 'compensated' | 'rejected';

const sagaRow = z.object({
	id: z.string(),
	workspace_id: z.number(),
	project_id: z.number(),
	title: z.string(),
	state: z.enum(states)
});
type SagaRow = z.infer<typeof sagaRow>;

const setState = async (s: Services, id: string, state: SagaState): Promise<void> => {
	await s.work.query('UPDATE sagas SET state = $2, updated_at = now() WHERE id = $1', [id, state]);
};

async function startSaga(s: Services, op: Op): Promise<Result> {
	const saga: SagaRow = {
		id: `s${op.i}`,
		workspace_id: op.workspaceId,
		project_id: op.projectId,
		title: op.title,
		state: 'started'
	};
	// the log first — "this saga started". After this, whenever it dies, recovery knows where to pick up.
	await s.work.query(
		'INSERT INTO sagas (id, workspace_id, project_id, title, state) VALUES ($1, $2, $3, $4, $5)',
		[saga.id, saga.workspace_id, saga.project_id, saga.title, saga.state]
	);
	return advance(s, saga, op.crash);
}

// Take a saga from its current state to the end — both new sagas and recovery use this
async function advance(s: Services, saga: SagaRow, crashAfterReserve: boolean): Promise<Result> {
	let state: SagaState = saga.state;
	if (state === 'started') {
		const r = await reserve(s, saga.id, saga.workspace_id);
		if (crashAfterReserve) throw new Crash(); // billing is written, the log still says 'started'
		if (r === 'rejected') {
			await setState(s, saga.id, 'rejected');
			return 'rejected';
		}
		await setState(s, saga.id, 'reserved');
		state = 'reserved';
	}
	if (state === 'reserved') {
		const r = await createTask(s, {
			sagaId: saga.id,
			workspaceId: saga.workspace_id,
			projectId: saga.project_id,
			title: saga.title
		});
		if (r === 'done') return 'done';
		await setState(s, saga.id, 'compensating'); // the log first, then the reverse action
		state = 'compensating';
	}
	if (state === 'compensating') {
		await release(s, saga.id, saga.workspace_id);
		await setState(s, saga.id, 'compensated');
		return 'compensated';
	}
	return state === 'done' ? 'done' : state === 'compensated' ? 'compensated' : 'rejected';
}

// The orchestrator came back: advance each saga that is midway in the log from where it stopped
async function recover(s: Services): Promise<void> {
	const r = await s.work.query(
		"SELECT id, workspace_id, project_id, title, state FROM sagas WHERE state IN ('started', 'reserved', 'compensating')"
	);
	for (const saga of z.array(sagaRow).parse(r.rows)) await advance(s, saga, false);
}

const stateCount = z.object({ state: z.enum(states), n: z.coerce.number() });
async function sagaStates(s: Services): Promise<Record<SagaState, number>> {
	const out: Record<SagaState, number> = {
		started: 0,
		reserved: 0,
		done: 0,
		compensating: 0,
		compensated: 0,
		rejected: 0
	};
	const r = await s.work.query('SELECT state, count(*) AS n FROM sagas GROUP BY 1');
	for (const row of z.array(stateCount).parse(r.rows)) out[row.state] = row.n;
	return out;
}

// ── a. crash, archived, recovery ──

type Row = {
	name: string;
	done: number;
	archived: number;
	crashed: string;
	unfinished: string;
	opsPerSec: string;
	p50: string;
};

async function printRow(row: Row, s: Services): Promise<void> {
	const t = tally(
		await perWorkspace(s.work, TASKS_PER_WS),
		await perWorkspace(s.billing, COUNTER_PER_WS),
		cfg.WORKSPACES
	);
	console.log(
		`   ${row.name.padEnd(40)} ${pad(row.done, 6)} ${pad(row.archived, 9)} ${pad(row.crashed, 6)} ${pad(row.unfinished, 9)} ${pad(t.taskRows, 8)} ${pad(t.counterSum, 8)} ${pad(t.mismatched, 8)}   ${verdict(t).padEnd(22)} ${pad(row.opsPerSec, 6)} ${pad(row.p50, 8)}`
	);
}

async function timed(
	ops: Op[],
	fn: (op: Op) => Promise<void>
): Promise<{ opsPerSec: string; p50: string }> {
	const latencies: number[] = [];
	const began = performance.now();
	await runWorkers(ops, cfg.CONCURRENCY, async (op) => {
		const t = performance.now();
		await fn(op);
		latencies.push(performance.now() - t);
	});
	const elapsed = performance.now() - began;
	return {
		opsPerSec: ((ops.length / elapsed) * 1000).toFixed(0),
		p50: ms(percentile(latencies, 50))
	};
}

const archivedIn = (projectId: number): boolean =>
	mulberry32(cfg.SEED * 7919 + projectId)() < cfg.ARCHIVED_RATE;

async function withoutSaga(ops: Op[]): Promise<void> {
	await reset(cfg.WORKSPACES, 1_000_000, 0, archivedIn, cfg.PROJECTS);
	const s = services(false, 0, cfg.CONCURRENCY);
	let done = 0;
	let archived = 0;
	let crashed = 0;
	// Without a saga: billing first (check the limit and count), then the task — no log, no reverse action
	const time = await timed(ops, async (op) => {
		await reserve(s, `x${op.i}`, op.workspaceId);
		if (op.crash) {
			crashed++;
			return;
		}
		const r = await createTask(s, { sagaId: null, ...op });
		if (r === 'done') done++;
		else archived++;
	});
	await printRow(
		{
			name: 'two writes, no saga',
			done,
			archived,
			crashed: String(crashed),
			unfinished: '—',
			...time
		},
		s
	);
	await closeServices(s);
}

async function withSaga(ops: Op[], idempotent: boolean): Promise<void> {
	await reset(cfg.WORKSPACES, 1_000_000, 0, archivedIn, cfg.PROJECTS);
	const s = services(idempotent, 0, cfg.CONCURRENCY);
	let crashed = 0;
	const time = await timed(ops, async (op) => {
		try {
			await startSaga(s, op);
		} catch (error: unknown) {
			if (!(error instanceof Crash)) throw error;
			crashed++;
		}
	});
	const before = await sagaStates(s);
	await printRow(
		{
			name: idempotent ? 'saga (idempotent steps)' : 'saga, steps not idempotent',
			done: before.done,
			archived: before.compensated,
			crashed: String(crashed),
			unfinished: String(before.started + before.reserved + before.compensating),
			...time
		},
		s
	);
	const began = performance.now();
	await recover(s);
	const took = ms(performance.now() - began);
	const after = await sagaStates(s);
	await printRow(
		{
			name: `  … recovery from the log (${took})`,
			done: after.done,
			archived: after.compensated,
			crashed: '—',
			unfinished: String(after.started + after.reserved + after.compensating),
			opsPerSec: '—',
			p50: '—'
		},
		s
	);
	await closeServices(s);
}

// ── b. near the limit — no isolation ──

async function nearLimit(
	policy: 'reserve' | 'check',
	ops: Op[],
	archivedNear: Set<number>
): Promise<void> {
	await reset(cfg.NEAR_WORKSPACES, cfg.LIMIT, cfg.USED, (id) => archivedNear.has(id), ops.length);
	const s = services(true, cfg.STEP_MS, cfg.ATTEMPTS * 4);
	const rejected = new Map<number, number>();
	let created = 0;
	let compensated = 0;
	const no = (ws: number): void => {
		rejected.set(ws, (rejected.get(ws) ?? 0) + 1);
	};
	// the same workspace's ATTEMPTS operations side by side in the list — so they run together
	await runWorkers(ops, cfg.ATTEMPTS * 4, async (op) => {
		if (policy === 'reserve') {
			// Saga: reserve first (counted in billing, before the task exists) → task → return it if archived
			const r = await startSaga(s, op);
			if (r === 'done') created++;
			else if (r === 'compensated') compensated++;
			else no(op.workspaceId);
			return;
		}
		// check first ("is there room?"), then the task, then increment usage at the end — nothing is held in between
		const r = await s.billing.query(
			'SELECT task_count < task_limit AS ok FROM workspaces WHERE id = $1',
			[op.workspaceId]
		);
		if (!z.object({ ok: z.boolean() }).parse(r.rows[0]).ok) return no(op.workspaceId);
		const t = await createTask(s, { sagaId: null, ...op });
		if (t === 'archived') return;
		created++;
		await s.billing.query('UPDATE workspaces SET task_count = task_count + 1 WHERE id = $1', [
			op.workspaceId
		]);
	});
	const tasks = await perWorkspace(s.work, TASKS_PER_WS);
	let overWs = 0;
	let extra = 0;
	let falseNo = 0;
	let saidNo = 0;
	for (let w = 1; w <= cfg.NEAR_WORKSPACES; w++) {
		const n = tasks.get(w) ?? 0;
		const r = rejected.get(w) ?? 0;
		saidNo += r;
		if (n > cfg.LIMIT) {
			overWs++;
			extra += n - cfg.LIMIT;
		}
		// at the end there was room, yet "limit reached" had been said
		falseNo += Math.min(r, Math.max(0, cfg.LIMIT - n));
	}
	const label =
		policy === 'reserve' ? 'reserve → task → release (saga)' : 'check → task → count usage at end';
	console.log(
		`   ${label.padEnd(40)} ${pad(created, 5)} ${pad(policy === 'reserve' ? compensated : '—', 7)} ${pad(saidNo, 11)} ${pad(overWs, 14)} ${pad(extra, 11)} ${pad(falseNo, 15)}`
	);
	await closeServices(s);
}

async function main(): Promise<void> {
	await ensureDatabases();
	const ops: Op[] = Array.from({ length: cfg.OPS }, (_, i) => ({
		i,
		workspaceId: ((i * 31) % cfg.WORKSPACES) + 1,
		projectId: ((i * 17) % cfg.PROJECTS) + 1,
		title: `Task ${i + 1}`,
		crash: mulberry32(cfg.SEED * 100_003 + i)() < cfg.CRASH_RATE
	}));
	const crashes = ops.filter((o) => o.crash).length;
	const archivedOps = ops.filter((o) => !o.crash && archivedIn(o.projectId)).length;

	console.log(
		`\n── A. ${cfg.OPS} "create task" — crash after writing to billing in ${crashes} (${(cfg.CRASH_RATE * 100).toFixed(0)}%), ${archivedOps} with an archived project, ${cfg.CONCURRENCY} concurrent ──`
	);
	console.log(
		'   path                                       done  archived  crash   pending    tasks  counter   bad ws   result                  ops/s      p50'
	);
	await withoutSaga(ops);
	await withSaga(ops, true);
	await withSaga(ops, false);

	const near: Op[] = [];
	for (let w = 1; w <= cfg.NEAR_WORKSPACES; w++)
		for (let k = 0; k < cfg.ATTEMPTS; k++) {
			const i = near.length;
			near.push({ i, workspaceId: w, projectId: i + 1, title: `Task ${i + 1}`, crash: false });
		}
	const archivedNear = new Set(
		near
			.filter((o) => mulberry32(cfg.SEED * 104_729 + o.i)() < cfg.NEAR_ARCHIVED_RATE)
			.map((o) => o.projectId)
	);
	console.log(
		`\n── B. Near the limit: ${cfg.NEAR_WORKSPACES} workspaces, limit ${cfg.LIMIT}, ${cfg.USED} tasks already — ${cfg.ATTEMPTS} concurrent "create task" in each, ${archivedNear.size} with an archived project ──`
	);
	console.log(
		'   rule                                      made  undone     refused  ws over limit       extra  false refusals'
	);
	await nearLimit('reserve', near, archivedNear);
	await nearLimit('check', near, archivedNear);
	console.log(
		'\n   (false refusals = at the end the workspace had room, yet it was told no — the room was held by a saga that later gave it back.)\n'
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
