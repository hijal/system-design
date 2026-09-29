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

// Lesson 9.3 §১.২–১.৩ — Two-phase commit (2PC), Postgres এর আসল PREPARE TRANSACTION দিয়ে।
//
// "Task তৈরি" = tasks_svc এ task এর row + billing_svc এ workspace এর task_count + 1 — Lesson 9.1 এর একই
// operation, একই seed, একই ৮৩টা crash। এবার দুটো database কে 2PC দিয়ে এক সিদ্ধান্তে বাঁধা:
//   ক. crash হলে কী হয়, আর দাম কত (ops/s, p50) — এক transaction আর দুটো আলাদা লেখার পাশে
//   খ. coordinator PREPARE এর পরে মারা গেলে: in-doubt transaction আর তাদের lock — বাকিদের কী হয়
//   গ. coordinator ফিরে এসে log পড়ে সিদ্ধান্ত দিলে, বনাম একটা participant অপেক্ষা না করে নিজে সিদ্ধান্ত নিলে

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
	// twopc_log — coordinator এর সিদ্ধান্তের খাতা। Coordinator এখানে work service, তাই তার নিজের database এ।
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

// কোথায় থামবে: 'none' — পুরো protocol; বাকিগুলো coordinator এর মৃত্যুর তিনটা মুহূর্ত
type Stop = 'none' | 'crash-before-prepare' | 'die-after-prepare' | 'die-after-decision';

// Coordinator — এখানে work service নিজেই (সে-ই "task তৈরি" শুরু করে)
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
		// lock_timeout: row এর lock এর জন্য সর্বোচ্চ কত ms অপেক্ষা; 0 মানে চিরকাল (Postgres এর default)
		await b.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
		// কাজ: প্রতিটা participant নিজের অংশ লেখে — এখনো commit না, row এর lock ধরা
		await a.query(insertTask, [op.workspaceId, op.title]);
		if (stop === 'crash-before-prepare') throw new Crash();
		await b.query(bumpCounter, [op.workspaceId]);
		// Phase 1 — prepare: "commit করতে পারবে?" প্রতিটা participant নিজের অংশ disk এ লিখে "হ্যাঁ" বলে।
		// এরপর সে আর নিজে থেকে commit বা rollback করতে পারে না — lock ধরে coordinator এর অপেক্ষা।
		await Promise.all([
			a.query(`PREPARE TRANSACTION '${gid}:tasks'`),
			b.query(`PREPARE TRANSACTION '${gid}:billing'`)
		]);
		prepared = true;
		if (stop === 'die-after-prepare') return; // coordinator মারা গেল — সিদ্ধান্ত কোথাও লেখা নেই
		// সিদ্ধান্ত coordinator এর নিজের log এ। এই লেখাটা commit হওয়াই পুরো transaction এর commit এর মুহূর্ত।
		await a.query('INSERT INTO twopc_log (gid, decision) VALUES ($1, $2)', [gid, 'commit']);
		if (stop === 'die-after-decision') return; // সিদ্ধান্ত লেখা হলো, কিন্তু কাউকে জানানো হলো না
		// Phase 2 — commit: সিদ্ধান্ত সবাইকে
		await Promise.all([
			a.query(`COMMIT PREPARED '${gid}:tasks'`),
			b.query(`COMMIT PREPARED '${gid}:billing'`)
		]);
	} catch (error: unknown) {
		// Crash এ connection কেটে যায় — prepare না হওয়া transaction Postgres নিজেই ROLLBACK করে
		if (error instanceof Crash) destroy = true;
		else if (!prepared) await Promise.all([a.query('ROLLBACK'), b.query('ROLLBACK')]);
		throw error;
	} finally {
		a.release(destroy);
		b.release(destroy);
	}
}

// ── ক. crash আর দাম ──

type Path = {
	name: string;
	run: (op: Op) => Promise<void>;
	count: () => Promise<Tally>;
	close: () => Promise<void>;
};

function monolithPath(): Path {
	const db = pool('taskflow', cfg.CONCURRENCY);
	return {
		name: 'monolith: একটা transaction (9.1)',
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
		name: 'services: দুটো আলাদা লেখা (9.1)',
		async run(op) {
			await ps.tasks.query(insertTask, [op.workspaceId, op.title]); // নিজে commit — ফেরানো যায় না
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
		`   ${path.name.padEnd(36)} ${pad(succeeded, 6)} ${pad(failed, 6)} ${pad(t.taskRows, 8)} ${pad(t.counterSum, 8)} ${pad(t.mismatched, 8)}   ${verdict(t).padEnd(20)} ${pad(((ops.length / elapsed) * 1000).toFixed(0), 6)} ${pad(ms(percentile(latencies, 50)), 8)}`
	);
	await path.close();
}

// ── খ. in doubt ──

async function makeInDoubt(ps: Participants): Promise<void> {
	for (let w = 1; w <= cfg.IN_DOUBT; w++) {
		const op: Op = { i: -w, workspaceId: w, title: `in-doubt ${w}`, crash: false };
		// প্রথম LOGGED টার সিদ্ধান্ত log এ লেখা হয়েছিল (তারপর মৃত্যু); বাকিগুলোর PREPARE এর পরেই মৃত্যু
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
	// প্রতিটা client এর চলতি operation কখন শুরু হয়েছিল (null = এই মুহূর্তে কিছু করছে না)
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
			if (end > deadline) break; // সময় শেষ হওয়ার পরে যা শেষ হলো, সেটা গোনা হয় না
			if (lockError) lockFailed++;
			else ok++;
			latencies.push(end - t);
		}
	};
	const running = Promise.all(Array.from({ length: cfg.CONCURRENCY }, (_, id) => client(id)));
	await sleep(cfg.DURATION_MS);

	// "আটকে থাকা" = চলতি operation ১ s এর বেশি ধরে চলছে (স্বাভাবিক operation কয়েক ms)
	const stuckSince = busySince.filter((s): s is number => s !== null && deadline - s > 1000);
	const allStuckAt =
		stuckSince.length === cfg.CONCURRENCY ? `${ms(Math.max(...stuckSince) - began)} এ` : '—';
	// Coordinator ফিরে এসে সিদ্ধান্ত দেয় — lock ছাড়ে, আটকে থাকা client গুলো এগোয়
	await recover();
	await running;
	await closeAll(ps);
	console.log(
		`   ${label.padEnd(24)} ${pad(ok, 6)} ${pad(((ok / cfg.DURATION_MS) * 1000).toFixed(0), 7)} ${pad(lockFailed, 13)} ${pad(ms(percentile(latencies, 99)), 9)} ${pad(`${stuckSince.length} / ${cfg.CONCURRENCY}`, 18)}   ${allStuckAt}`
	);
}

// ── গ. recovery ──

type Outcome = { commit: number; rollback: number };

const logRow = z.object({ gid: z.string() });
const gidRow = z.object({ gid: z.string() });

// Coordinator আবার চালু হলো: নিজের log পড়ে প্রতিটা in-doubt transaction এর সিদ্ধান্ত পাঠায়।
// Log এ "commit" নেই মানে commit এর সিদ্ধান্ত কখনো হয়নি — তাই rollback ("presumed abort")।
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

// Billing এর একজন operator অপেক্ষা করতে করতে বিরক্ত — নিজের দিকের prepared transaction নিজে ROLLBACK করল
// (বাণিজ্যিক database এ এর নাম "heuristic decision")
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
		`\n── ক. ${cfg.OPS} টা "task তৈরি", ${cfg.WORKSPACES} টা workspace, ${crashes} টায় প্রথম লেখার পরে crash (${(cfg.CRASH_RATE * 100).toFixed(0)}%), ${cfg.CONCURRENCY} টা একসাথে ──`
	);
	console.log(
		`   ${'পথ'.padEnd(36)}  সফল   ব্যর্থ  task row  counter  অমিল ws   ফল                    ops/s      p50`
	);
	for (const path of [monolithPath(), twoWritesPath(), twoPhasePath()]) await runPath(path, ops);

	console.log(
		`\n── খ. Coordinator মারা গেল PREPARE এর পরে, COMMIT এর আগে — ${cfg.IN_DOUBT} টা workspace এর transaction "in doubt" ──`
	);
	await reset();
	const ps = participants();
	await makeInDoubt(ps);
	const t0 = performance.now();
	const read = await ps.billing.query('SELECT task_count FROM workspaces WHERE id = 1');
	const readMs = performance.now() - t0;
	const readValue = z.object({ task_count: z.number() }).parse(read.rows[0]).task_count;
	console.log(
		`   prepared হয়ে পড়ে আছে: tasks_svc এ ${await preparedCount(ps.tasks)} টা, billing_svc এ ${await preparedCount(ps.billing)} টা · coordinator এর log এ "commit": ${cfg.LOGGED} টা`
	);
	console.log(
		`   workspace 1 এর task_count পড়া (SELECT): ${readValue} — ${ms(readMs)}, আটকায়নি (MVCC: commit হওয়া পুরনো মান)`
	);
	await closeAll(ps);
	await recover();
	console.log(
		`   তারপর ${cfg.DURATION_MS / 1000} s ধরে ${cfg.CONCURRENCY} জন client নতুন task বানাচ্ছে (2PC, ${cfg.WORKSPACES} টা workspace এ random):`
	);
	console.log(
		`   ${'billing এর lock_timeout'.padEnd(24)}   সফল   ops/s   lock এ ব্যর্থ       p99   শেষে আটকে থাকা client   সবাই আটকে গেল`
	);
	await loadWhileInDoubt('নেই (Postgres default)', 0);
	await loadWhileInDoubt(`${cfg.LOCK_TIMEOUT_MS} ms`, cfg.LOCK_TIMEOUT_MS);

	console.log(`\n── গ. তারপর: in-doubt transaction গুলোর সিদ্ধান্ত ──`);
	console.log(
		`   ${'কে সিদ্ধান্ত নিল'.padEnd(44)} ${'tasks_svc'.padEnd(22)} ${'billing_svc'.padEnd(22)} অমিল ws   ফল`
	);
	await recoveryRow('coordinator ফিরে এসে, log ধরে (নেই → rollback)', false);
	await recoveryRow('billing অপেক্ষা না করে নিজে ROLLBACK, তারপর coordinator', true);
	await clearPrepared();
	console.log(
		'\n   (2PC এ crash মানে কিছুই না ঘটা — যতক্ষণ coordinator PREPARE এর আগে মরে। পরে মরলে, সে ফেরা পর্যন্ত lock ধরা।)\n'
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
