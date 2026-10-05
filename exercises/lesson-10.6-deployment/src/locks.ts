import { Client, Pool } from 'pg';
import { env, heading, ms, mulberry32, n, row, sleep } from './util';

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5449/taskflow';
const ROWS = env('ROWS', 1_000_000);
const WORKERS = env('WORKERS', 8);
const LONG_QUERY_MS = env('LONG_QUERY_MS', 6_000);
const LOCK_TIMEOUT_MS = env('LOCK_TIMEOUT_MS', 200);
const BATCH = env('BATCH', 10_000);
const SLOW_MS = 500;

const pool = new Pool({ connectionString: DATABASE_URL, max: WORKERS + 2 });

type Op = { kind: 'read' | 'write'; start: number; latency: number; ok: boolean };

function pgCode(error: unknown): string | undefined {
	if (typeof error === 'object' && error !== null && 'code' in error) {
		const code: unknown = error.code;
		if (typeof code === 'string') return code;
	}
	return undefined;
}

async function connect(): Promise<Client> {
	const client = new Client({ connectionString: DATABASE_URL });
	await client.connect();
	return client;
}

function appLoad(seed: number): { stop: () => Promise<Op[]> } {
	const random = mulberry32(seed);
	const ops: Op[] = [];
	let running = true;
	const worker = async (): Promise<void> => {
		while (running) {
			const id = 1 + Math.floor(random() * ROWS);
			const kind = random() < 0.5 ? 'read' : 'write';
			const start = performance.now();
			try {
				if (kind === 'read')
					await pool.query('SELECT id, title, status FROM tasks WHERE id = $1', [id]);
				else
					await pool.query('UPDATE tasks SET status = $2 WHERE id = $1', [
						id,
						random() < 0.5 ? 'todo' : 'done'
					]);
				ops.push({ kind, start, latency: performance.now() - start, ok: true });
			} catch {
				ops.push({ kind, start, latency: performance.now() - start, ok: false });
			}
			await sleep(5);
		}
	};
	const workers = Array.from({ length: WORKERS }, () => worker());
	return {
		stop: async () => {
			running = false;
			await Promise.all(workers);
			return ops;
		}
	};
}

type Result = { label: string; seconds: number; ops: Op[]; note: string };

async function measure(label: string, action: () => Promise<string>): Promise<Result> {
	const load = appLoad(label.length * 31);
	await sleep(800);
	const t0 = performance.now();
	const note = await action();
	const t1 = performance.now();
	await sleep(800);
	const all = await load.stop();
	const ops = all.filter((o) => o.start < t1 && o.start + o.latency > t0);
	return { label, seconds: (t1 - t0) / 1_000, ops, note };
}

function print(results: Result[]): void {
	console.log(
		row([
			['change', 46],
			['time', 10],
			['app op', 9],
			['read max', 14],
			['write max', 14],
			[`> ${SLOW_MS} ms`, 11],
			['error', 7]
		])
	);
	for (const r of results) {
		const max = (kind: Op['kind']): number =>
			Math.max(0, ...r.ops.filter((o) => o.kind === kind).map((o) => o.latency));
		console.log(
			row([
				[r.label, 46],
				[ms(r.seconds * 1_000), 10],
				[n(r.ops.length), 9],
				[ms(max('read')), 14],
				[ms(max('write')), 14],
				[n(r.ops.filter((o) => o.latency > SLOW_MS).length), 11],
				[n(r.ops.filter((o) => !o.ok).length), 7]
			])
		);
		if (r.note) console.log(`   ${r.note}`);
	}
}

async function holdLongQuery(): Promise<{ done: Promise<void> }> {
	const long = await connect();
	await long.query('BEGIN');
	await long.query('SELECT count(*) FROM tasks');
	const done = long
		.query('SELECT pg_sleep($1)', [LONG_QUERY_MS / 1_000])
		.then(() => long.query('COMMIT'))
		.then(() => long.end());
	return { done };
}

async function ddl(sql: string): Promise<number> {
	const client = await connect();
	const started = performance.now();
	try {
		await client.query(sql);
	} finally {
		await client.end();
	}
	return performance.now() - started;
}

async function main(): Promise<void> {
	const setup = await connect();
	await setup.query('DROP TABLE IF EXISTS tasks');
	await setup.query(
		`CREATE TABLE tasks (id bigint PRIMARY KEY, board_id int NOT NULL, title text NOT NULL, status text NOT NULL DEFAULT 'todo')`
	);
	await setup.query(
		`INSERT INTO tasks SELECT g, (g % 20000) + 1, 'task ' || g, 'todo' FROM generate_series(1, $1::int) g`,
		[ROWS]
	);
	await setup.query('VACUUM ANALYZE tasks');
	const version = await setup.query<{ server_version: string }>('SHOW server_version');
	await setup.end();
	console.log(
		`Postgres ${version.rows[0]?.server_version ?? '?'}, ${n(ROWS)} rows in tasks; app: ${WORKERS} workers, half SELECT half UPDATE, by id`
	);

	heading(
		'Part A — adding a column: which is instant, which locks the whole table, and the lock queue'
	);
	const partA: Result[] = [];
	partA.push(
		await measure('ADD COLUMN archived boolean DEFAULT false', async () => {
			await ddl('ALTER TABLE tasks ADD COLUMN archived boolean NOT NULL DEFAULT false');
			return '';
		})
	);
	partA.push(
		await measure('ADD COLUMN score float DEFAULT random()', async () => {
			await ddl('ALTER TABLE tasks ADD COLUMN score float NOT NULL DEFAULT random()');
			return '';
		})
	);
	partA.push(
		await measure(
			`ADD COLUMN priority int, behind a ${LONG_QUERY_MS / 1_000} s query`,
			async () => {
				const { done: longDone } = await holdLongQuery();
				await sleep(300);
				const took = await ddl('ALTER TABLE tasks ADD COLUMN priority int');
				await longDone;
				return `the ALTER itself waited ${ms(took)} — and everyone behind it`;
			}
		)
	);
	partA.push(
		await measure(`the same, lock_timeout ${LOCK_TIMEOUT_MS} ms + retry`, async () => {
			const { done: longDone } = await holdLongQuery();
			await sleep(300);
			let attempts = 0;
			for (;;) {
				attempts++;
				const client = await connect();
				try {
					await client.query(`SET lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
					await client.query('ALTER TABLE tasks ADD COLUMN labels text');
					break;
				} catch (error: unknown) {
					if (pgCode(error) !== '55P03') throw error;
					await sleep(1_000);
				} finally {
					await client.end();
				}
			}
			await longDone;
			return `${attempts} attempts, each giving up and stepping aside after ${LOCK_TIMEOUT_MS} ms`;
		})
	);
	print(partA);

	heading('Part B — building an index: on board_id');
	const partB: Result[] = [];
	partB.push(
		await measure('CREATE INDEX', async () => {
			await ddl('CREATE INDEX tasks_board_idx ON tasks (board_id)');
			return '';
		})
	);
	await ddl('DROP INDEX tasks_board_idx');
	partB.push(
		await measure('CREATE INDEX CONCURRENTLY', async () => {
			await ddl('CREATE INDEX CONCURRENTLY tasks_board_idx ON tasks (board_id)');
			return '';
		})
	);
	print(partB);

	heading(`Part C — backfill: priority = 0, ${n(ROWS)} rows`);
	const partC: Result[] = [];
	partC.push(
		await measure('all in one UPDATE', async () => {
			await ddl('UPDATE tasks SET priority = 0');
			return '';
		})
	);
	await ddl('UPDATE tasks SET priority = NULL');
	await ddl('VACUUM tasks');
	partC.push(
		await measure(`in batches (${n(BATCH)} each, 20 ms apart)`, async () => {
			const client = await connect();
			let batches = 0;
			for (let from = 0; from < ROWS; from += BATCH) {
				await client.query(
					'UPDATE tasks SET priority = 0 WHERE id > $1 AND id <= $2 AND priority IS NULL',
					[from, from + BATCH]
				);
				batches++;
				await sleep(20);
			}
			await client.end();
			return `${batches} small transactions`;
		})
	);
	print(partC);

	heading('Part D — adding NOT NULL: priority');
	const partD: Result[] = [];
	partD.push(
		await measure('SET NOT NULL (directly)', async () => {
			await ddl('ALTER TABLE tasks ALTER COLUMN priority SET NOT NULL');
			return '';
		})
	);
	await ddl('ALTER TABLE tasks ALTER COLUMN priority DROP NOT NULL');
	partD.push(
		await measure('CHECK NOT VALID → VALIDATE → SET NOT NULL', async () => {
			const a = await ddl(
				'ALTER TABLE tasks ADD CONSTRAINT priority_not_null CHECK (priority IS NOT NULL) NOT VALID'
			);
			const b = await ddl('ALTER TABLE tasks VALIDATE CONSTRAINT priority_not_null');
			const c = await ddl('ALTER TABLE tasks ALTER COLUMN priority SET NOT NULL');
			const d = await ddl('ALTER TABLE tasks DROP CONSTRAINT priority_not_null');
			return `NOT VALID ${ms(a)}, VALIDATE ${ms(b)} (lock: SHARE UPDATE EXCLUSIVE), SET NOT NULL ${ms(c)} (scan skipped), DROP CHECK ${ms(d)}`;
		})
	);
	print(partD);
	await pool.end();
}

main().catch(async (error: unknown) => {
	console.error(error);
	await pool.end();
	process.exitCode = 1;
});
