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
	verdict,
	type Tally
} from './db';
import { mulberry32, ms, pad, percentile, sleep } from './random';

// Lesson 9.3 §1.2–1.3 — two-phase commit (2PC), with Postgres's real PREPARE TRANSACTION.
//
// "Create task" = a task row in tasks_svc + the workspace's task_count + 1 in billing_svc — the same operation as
// Lesson 9.1, the same seed, the same 83 crashes. This time the two databases are bound to one decision with 2PC:
//   a. what happens on a crash, and the price (ops/s, p50) — next to one transaction and two separate writes
//   b. when the coordinator dies after PREPARE: in-doubt transactions and their locks — what happens to everyone else
//   c. the coordinator coming back and deciding from its log, vs a participant deciding on its own without waiting

const cfg = z
	.object({
		OPS: z.coerce.number().int().positive().default(3000),
		WORKSPACES: z.coerce.number().int().positive().default(100),
		CRASH_RATE: z.coerce.number().min(0).max(1).default(0.03),
		CONCURRENCY: z.coerce.number().int().positive().default(8),
		SEED: z.coerce.number().int().default(7),
		IN_DOUBT: z.coerce.number().int().min(1).max(50).default(5),
		LOGGED: z.coerce.number().int().min(0).default(2),
		DURATION_MS: z.coerce.number().int().positive().default(3000),
		LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(200)
	})
	.parse(process.env);

const insertTask = 'INSERT INTO tasks (workspace_id, title) VALUES ($1, $2)';
const bumpCounter = 'UPDATE workspaces SET task_count = task_count + 1 WHERE id = $1';

async function reset(): Promise<void> {
	await clearPrepared();
	const seed = `INSERT INTO workspaces (id, plan) SELECT g, CASE WHEN g % 3 = 0 THEN 'pro' ELSE 'free' END FROM generate_series(1, ${cfg.WORKSPACES}) g`;
	const workspaces = `DROP TABLE IF EXISTS workspaces;
		CREATE TABLE workspaces (id int PRIMARY KEY, plan text NOT NULL, task_count int NOT NULL DEFAULT 0);
		${seed};`;
	const mono = pool('taskflow', 1);
	await mono.query(`DROP TABLE IF EXISTS tasks; ${workspaces}
		CREATE TABLE tasks (id bigserial PRIMARY KEY, workspace_id int NOT NULL REFERENCES workspaces, title text NOT NULL);`);
	await mono.end();
	const tasks = pool('tasks_svc', 1);
	// twopc_log — the coordinator's ledger of decisions. Here the coordinator is the work service, so it's in its own database.
	await tasks.query(`
		DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS twopc_log;
		CREATE TABLE tasks (id bigserial PRIMARY KEY, workspace_id int NOT NULL, title text NOT NULL);
		CREATE TABLE twopc_log (gid text PRIMARY KEY, decision text NOT NULL);`);
	await tasks.end();
	const billing = pool('billing_svc', 1);
	await billing.query(workspaces);
	await billing.end();
}

type Op = { i: number; workspaceId: number; title: string; crash: boolean };
type Participants = { tasks: Pool; billing: Pool };

const participants = (): Participants => ({
	tasks: pool('tasks_svc', cfg.CONCURRENCY),
	billing: pool('billing_svc', cfg.CONCURRENCY)
});
const closeAll = async (ps: Participants): Promise<void> => {
	await ps.tasks.end();
	await ps.billing.end();
};

// where it stops: 'none' — the whole protocol; the rest are three moments of the coordinator's death
type Stop = 'none' | 'crash-before-prepare' | 'die-after-prepare' | 'die-after-decision';

// The coordinator — here the work service itself (it is the one starting "create task")
async function twoPhase(
	ps: Participants,
	op: Op,
	gid: string,
	stop: Stop,
	lockTimeoutMs: number
): Promise<void> {
	const [a, b] = await Promise.all([ps.tasks.connect(), ps.billing.connect()]);
	let prepared = false;
	let destroy = false;
	try {
		await Promise.all([a.query('BEGIN'), b.query('BEGIN')]);
		// lock_timeout: the longest to wait for a row lock, in ms; 0 means forever (Postgres's default)
		await b.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
		// the work: each participant writes its own part — not committed yet, holding the row locks
		await a.query(insertTask, [op.workspaceId, op.title]);
		if (stop === 'crash-before-prepare') throw new Crash();
		await b.query(bumpCounter, [op.workspaceId]);
		// Phase 1 — prepare: "can you commit?" Each participant writes its part to disk and says "yes".
		// After this it can no longer commit or roll back on its own — it holds the locks and waits for the coordinator.
		await Promise.all([
			a.query(`PREPARE TRANSACTION '${gid}:tasks'`),
			b.query(`PREPARE TRANSACTION '${gid}:billing'`)
		]);
		prepared = true;
		if (stop === 'die-after-prepare') return; // the coordinator died — the decision isn't written anywhere
		// The decision goes in the coordinator's own log. This write committing is the moment the whole transaction commits.
		await a.query('INSERT INTO twopc_log (gid, decision) VALUES ($1, $2)', [gid, 'commit']);
		if (stop === 'die-after-decision') return; // the decision is written, but nobody was told
		// Phase 2 — commit: the decision to everyone
		await Promise.all([
			a.query(`COMMIT PREPARED '${gid}:tasks'`),
			b.query(`COMMIT PREPARED '${gid}:billing'`)
		]);
	} catch (error: unknown) {
		// a crash drops the connection — Postgres itself ROLLs BACK a transaction that was not prepared
		if (error instanceof Crash) destroy = true;
		else if (!prepared) await Promise.all([a.query('ROLLBACK'), b.query('ROLLBACK')]);
		throw error;
	} finally {
		a.release(destroy);
		b.release(destroy);
	}
}

// ── a. crash and the price ──

type Path = {
	name: string;
	run: (op: Op) => Promise<void>;
	count: () => Promise<Tally>;
	close: () => Promise<void>;
};

function monolithPath(): Path {
	const db = pool('taskflow', cfg.CONCURRENCY);
	return {
		name: 'monolith: one transaction (9.1)',
		async run(op) {
			const client = await db.connect();
			try {
				await client.query('BEGIN');
				await client.query(insertTask, [op.workspaceId, op.title]);
				if (op.crash) throw new Crash();
				await client.query(bumpCounter, [op.workspaceId]);
				await client.query('COMMIT');
			} catch (error: unknown) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
		},
		count: async () =>
			tally(
				await perWorkspace(db, TASKS_PER_WS),
				await perWorkspace(db, COUNTER_PER_WS),
				cfg.WORKSPACES
			),
		close: () => db.end()
	};
}

function twoWritesPath(): Path {
	const ps = participants();
	return {
		name: 'services: two separate writes (9.1)',
		async run(op) {
			await ps.tasks.query(insertTask, [op.workspaceId, op.title]); // commits on its own — can't be undone
			if (op.crash) throw new Crash();
			await ps.billing.query(bumpCounter, [op.workspaceId]);
		},
		count: async () =>
			tally(
				await perWorkspace(ps.tasks, TASKS_PER_WS),
				await perWorkspace(ps.billing, COUNTER_PER_WS),
				cfg.WORKSPACES
			),
		close: () => closeAll(ps)
	};
}

function twoPhasePath(): Path {
	const ps = participants();
	return {
		name: 'services: 2PC',
		run: (op) => twoPhase(ps, op, `op${op.i}`, op.crash ? 'crash-before-prepare' : 'none', 0),
		count: async () =>
			tally(
				await perWorkspace(ps.tasks, TASKS_PER_WS),
				await perWorkspace(ps.billing, COUNTER_PER_WS),
				cfg.WORKSPACES
			),
		close: () => closeAll(ps)
	};
}

async function runPath(path: Path, ops: Op[]): Promise<void> {
	await reset();
	let succeeded = 0;
	let failed = 0;
	const latencies: number[] = [];
	const began = performance.now();
	await runWorkers(ops, cfg.CONCURRENCY, async (op) => {
		const t = performance.now();
		try {
			await path.run(op);
			succeeded++;
		} catch (error: unknown) {
			if (!(error instanceof Crash)) throw error;
			failed++;
		}
		latencies.push(performance.now() - t);
	});
	const elapsed = performance.now() - began;
	const t = await path.count();
	console.log(
		`   ${path.name.padEnd(36)} ${pad(succeeded, 6)} ${pad(failed, 6)} ${pad(t.taskRows, 8)} ${pad(t.counterSum, 8)} ${pad(t.mismatched, 8)}   ${verdict(t).padEnd(22)} ${pad(((ops.length / elapsed) * 1000).toFixed(0), 6)} ${pad(ms(percentile(latencies, 50)), 8)}`
	);
	await path.close();
}

// ── b. in doubt ──

async function makeInDoubt(ps: Participants): Promise<void> {
	for (let w = 1; w <= cfg.IN_DOUBT; w++) {
		const op: Op = { i: -w, workspaceId: w, title: `in-doubt ${w}`, crash: false };
		// the first LOGGED ones had their decision written to the log (then death); the rest died right after PREPARE
		await twoPhase(
			ps,
			op,
			`doubt${w}`,
			w <= cfg.LOGGED ? 'die-after-decision' : 'die-after-prepare',
			0
		);
	}
}

const countOf = z.object({ n: z.coerce.number() });
async function preparedCount(p: Pool): Promise<number> {
	const r = await p.query(
		'SELECT count(*) AS n FROM pg_prepared_xacts WHERE database = current_database()'
	);
	return countOf.parse(r.rows[0]).n;
}

const isLockTimeout = (error: unknown): boolean =>
	typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03';

async function loadWhileInDoubt(label: string, lockTimeoutMs: number): Promise<void> {
	await reset();
	const ps = participants();
	await makeInDoubt(ps);
	const rand = mulberry32(cfg.SEED);
	let seq = 0;
	let ok = 0;
	let lockFailed = 0;
	const latencies: number[] = [];
	// when each client's current operation started (null = doing nothing right now)
	const busySince: (number | null)[] = Array.from({ length: cfg.CONCURRENCY }, () => null);
	const began = performance.now();
	const deadline = began + cfg.DURATION_MS;

	const client = async (id: number): Promise<void> => {
		while (performance.now() < deadline) {
			const op: Op = {
				i: seq++,
				workspaceId: Math.floor(rand() * cfg.WORKSPACES) + 1,
				title: 'load',
				crash: false
			};
			const t = performance.now();
			busySince[id] = t;
			let lockError = false;
			try {
				await twoPhase(ps, op, `load${op.i}`, 'none', lockTimeoutMs);
			} catch (error: unknown) {
				if (!isLockTimeout(error)) throw error;
				lockError = true;
			}
			const end = performance.now();
			busySince[id] = null;
			if (end > deadline) break; // whatever finishes after time is up isn't counted
			if (lockError) lockFailed++;
			else ok++;
			latencies.push(end - t);
		}
	};
	const running = Promise.all(Array.from({ length: cfg.CONCURRENCY }, (_, id) => client(id)));
	await sleep(cfg.DURATION_MS);

	// "stuck" = the current operation has been running more than 1 s (a normal operation takes a few ms)
	const stuckSince = busySince.filter((s): s is number => s !== null && deadline - s > 1000);
	const allStuckAt =
		stuckSince.length === cfg.CONCURRENCY ? `at ${ms(Math.max(...stuckSince) - began)}` : '—';
	// the coordinator comes back and decides — releases the locks, the stuck clients move on
	await recover();
	await running;
	await closeAll(ps);
	console.log(
		`   ${label.padEnd(24)} ${pad(ok, 6)} ${pad(((ok / cfg.DURATION_MS) * 1000).toFixed(0), 7)} ${pad(lockFailed, 13)} ${pad(ms(percentile(latencies, 99)), 9)} ${pad(`${stuckSince.length} / ${cfg.CONCURRENCY}`, 18)}   ${allStuckAt}`
	);
}

// ── c. recovery ──

type Outcome = { commit: number; rollback: number };

const logRow = z.object({ gid: z.string() });
const gidRow = z.object({ gid: z.string() });

// The coordinator came back: it reads its own log and sends the decision for each in-doubt transaction.
// No "commit" in the log means a commit decision was never made — so rollback ("presumed abort").
async function recover(): Promise<{ tasks: Outcome; billing: Outcome }> {
	const tasks = pool('tasks_svc', 1);
	const billing = pool('billing_svc', 1);
	const logged = new Set(
		z
			.array(logRow)
			.parse((await tasks.query("SELECT gid FROM twopc_log WHERE decision = 'commit'")).rows)
			.map((r) => r.gid)
	);
	const settle = async (p: Pool): Promise<Outcome> => {
		const out: Outcome = { commit: 0, rollback: 0 };
		const r = await p.query(
			'SELECT gid FROM pg_prepared_xacts WHERE database = current_database()'
		);
		for (const { gid } of z.array(gidRow).parse(r.rows)) {
			const base = gid.slice(0, gid.lastIndexOf(':'));
			if (logged.has(base)) {
				await p.query(`COMMIT PREPARED '${gid}'`);
				out.commit++;
			} else {
				await p.query(`ROLLBACK PREPARED '${gid}'`);
				out.rollback++;
			}
		}
		return out;
	};
	const result = { tasks: await settle(tasks), billing: await settle(billing) };
	await tasks.end();
	await billing.end();
	return result;
}

// A billing operator got tired of waiting — rolled back their side's prepared transactions themselves
// (commercial databases call this a "heuristic decision")
async function billingGivesUp(): Promise<number> {
	const billing = pool('billing_svc', 1);
	const r = await billing.query(
		'SELECT gid FROM pg_prepared_xacts WHERE database = current_database()'
	);
	const gids = z.array(gidRow).parse(r.rows);
	for (const { gid } of gids) await billing.query(`ROLLBACK PREPARED '${gid}'`);
	await billing.end();
	return gids.length;
}

async function recoveryRow(label: string, heuristic: boolean): Promise<void> {
	await reset();
	const ps = participants();
	await makeInDoubt(ps);
	const gaveUp = heuristic ? await billingGivesUp() : 0;
	const r = await recover();
	const t = tally(
		await perWorkspace(ps.tasks, TASKS_PER_WS),
		await perWorkspace(ps.billing, COUNTER_PER_WS),
		cfg.WORKSPACES
	);
	await closeAll(ps);
	const side = (o: Outcome, extraRollback: number): string =>
		`commit ${o.commit} · rollback ${o.rollback + extraRollback}`;
	console.log(
		`   ${label.padEnd(44)} ${side(r.tasks, 0).padEnd(22)} ${side(r.billing, gaveUp).padEnd(22)} ${pad(t.mismatched, 6)}   ${verdict(t)}`
	);
}

async function main(): Promise<void> {
	await ensureDatabases();
	const ops: Op[] = Array.from({ length: cfg.OPS }, (_, i) => ({
		i,
		workspaceId: ((i * 31) % cfg.WORKSPACES) + 1,
		title: `Task ${i + 1}`,
		crash: mulberry32(cfg.SEED * 100_003 + i)() < cfg.CRASH_RATE
	}));
	const crashes = ops.filter((o) => o.crash).length;

	console.log(
		`\n── A. ${cfg.OPS} "create task", ${cfg.WORKSPACES} workspaces, crash after the first write in ${crashes} (${(cfg.CRASH_RATE * 100).toFixed(0)}%), ${cfg.CONCURRENCY} concurrent ──`
	);
	console.log(
		'   path                                     ok failed    tasks  counter   bad ws   result                  ops/s      p50'
	);
	for (const path of [monolithPath(), twoWritesPath(), twoPhasePath()]) await runPath(path, ops);

	console.log(
		`\n── B. The coordinator died after PREPARE, before COMMIT — ${cfg.IN_DOUBT} workspaces' transactions "in doubt" ──`
	);
	await reset();
	const ps = participants();
	await makeInDoubt(ps);
	const t0 = performance.now();
	const read = await ps.billing.query('SELECT task_count FROM workspaces WHERE id = 1');
	const readMs = performance.now() - t0;
	const readValue = z.object({ task_count: z.number() }).parse(read.rows[0]).task_count;
	console.log(
		`   left prepared: ${await preparedCount(ps.tasks)} in tasks_svc, ${await preparedCount(ps.billing)} in billing_svc · "commit" in the coordinator's log: ${cfg.LOGGED}`
	);
	console.log(
		`   reading workspace 1's task_count (SELECT): ${readValue} — ${ms(readMs)}, not blocked (MVCC: the committed old value)`
	);
	await closeAll(ps);
	await recover();
	console.log(
		`   then ${cfg.CONCURRENCY} clients creating new tasks for ${cfg.DURATION_MS / 1000} s (2PC, random among ${cfg.WORKSPACES} workspaces):`
	);
	console.log(
		"   billing's lock_timeout       ok   ops/s    lock fails       p99       stuck at end   all stuck at"
	);
	await loadWhileInDoubt('none (Postgres default)', 0);
	await loadWhileInDoubt(`${cfg.LOCK_TIMEOUT_MS} ms`, cfg.LOCK_TIMEOUT_MS);

	console.log(`\n── C. What next: deciding the in-doubt transactions ──`);
	console.log(
		`   ${'who decided'.padEnd(44)} ${'tasks_svc'.padEnd(22)} ${'billing_svc'.padEnd(22)} bad ws   result`
	);
	await recoveryRow('coordinator, from its log (none → rollback)', false);
	await recoveryRow('billing rolled back alone, then coordinator', true);
	await clearPrepared();
	console.log(
		'\n   (in 2PC a crash means nothing happens — as long as the coordinator dies before PREPARE. If it dies later, the locks are held until it comes back.)\n'
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
