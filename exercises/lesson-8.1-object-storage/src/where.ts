import { execFile, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { messageSchema } from './downloader';
import { checkServices, emptyBucket, env, getObject, pgPool, putObject } from './storage';
import { mb, ms, mulberry32, percentile } from './random';

// Lesson 8.1 §1.2 — where to keep TaskFlow's attachments: in a Postgres bytea column, or in object
// storage (with only a metadata row in the database)?
//
//   step 1: the same FILES files kept in both places — time, how much WAL was written, how much the database grew
//   step 2: pg_dump — a backup of the database with the files, and without them (metadata only)
//   step 3: the board's OLTP queries are running; alongside, DOWNLOADERS people download files — from Postgres, then
//          from object storage. What happens to OLTP's p99?
//
// A real database, real time — the numbers will vary between machines, the shape should stay the same.

const cfg = z
	.object({
		FILES: z.coerce.number().int().positive().default(200),
		PHASE_MS: z.coerce.number().int().positive().default(8000),
		CLIENTS: z.coerce.number().int().positive().default(8),
		DOWNLOADERS: z.coerce.number().int().nonnegative().default(8),
		POOL_MAX: z.coerce.number().int().positive().default(10),
		// 1 = one more step: object storage files also go through the app (proxy) — experiment 2
		PROXY_S3: z.enum(['0', '1']).default('0'),
		SEED: z.coerce.number().int().default(7)
	})
	.parse(process.env);

const OLTP_SQL = `
	SELECT id, title, status FROM tasks
	WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 20`;

type FileSpec = { id: number; taskId: number; name: string; size: number };

// File sizes fixed by a seed: 70% small (50 KB–1 MB), 25% medium (1–5 MB), 5% large (5–10 MB) —
// screenshots, PDFs, and now and then a design file. The content is random bytes — like real PDFs/images/zips,
// it doesn't compress (those are already compressed themselves).
function fileSpecs(): FileSpec[] {
	const random = mulberry32(cfg.SEED);
	const KB = 1024;
	return Array.from({ length: cfg.FILES }, (_, i) => {
		const r = random();
		const [lo, hi] =
			r < 0.7 ? [50 * KB, 1024 * KB] : r < 0.95 ? [1024 * KB, 5120 * KB] : [5120 * KB, 10240 * KB];
		return {
			id: i + 1,
			taskId: Math.floor(random() * 200_000) + 1,
			name: `file-${i + 1}.pdf`,
			size: Math.floor(lo + (hi - lo) * random())
		};
	});
}

// run items with `concurrency` workers
async function inParallel<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const item = items[next++];
			if (item !== undefined) await fn(item);
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
}

async function walBytes(pool: Pool, fn: () => Promise<void>): Promise<number> {
	const lsn = z.object({ lsn: z.string() });
	const before = lsn.parse(
		(await pool.query('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0]
	).lsn;
	await fn();
	const diff = await pool.query(
		'SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::bigint AS bytes',
		[before]
	);
	return z.object({ bytes: z.coerce.number() }).parse(diff.rows[0]).bytes;
}

async function relationSize(pool: Pool, table: string): Promise<number> {
	const res = await pool.query('SELECT pg_total_relation_size($1::regclass)::bigint AS bytes', [
		table
	]);
	return z.object({ bytes: z.coerce.number() }).parse(res.rows[0]).bytes;
}

// running pg_dump inside the container — the size and time of the output
async function dump(excludeFiles: boolean): Promise<{ bytes: number; ms: number }> {
	const exclude = excludeFiles ? '-T attachments_blob' : '';
	const t = performance.now();
	const { stdout } = await promisify(execFile)(
		'docker',
		[
			'compose',
			'exec',
			'-T',
			'postgres',
			'sh',
			'-c',
			`pg_dump -U taskflow -Fc ${exclude} taskflow | wc -c`
		],
		{ cwd: path.join(__dirname, '..') }
	);
	return { bytes: Number(stdout.trim()), ms: performance.now() - t };
}

async function setup(pool: Pool): Promise<void> {
	await pool.query(`
		DROP TABLE IF EXISTS tasks, attachments_blob, attachments;
		CREATE TABLE tasks (
			id int PRIMARY KEY, project_id int NOT NULL, title text NOT NULL,
			status text NOT NULL, updated_at timestamptz NOT NULL
		);
		INSERT INTO tasks
		SELECT i, (i * 7919) % 5000 + 1, 'Task #' || i,
		       CASE i % 3 WHEN 0 THEN 'todo' WHEN 1 THEN 'doing' ELSE 'done' END,
		       TIMESTAMPTZ '2026-01-01' + (i * 37 % 31536000) * INTERVAL '1 second'
		FROM generate_series(1, 200000) AS i;
		CREATE INDEX tasks_board ON tasks (project_id, updated_at DESC);
		-- path a: the file itself in the database (DataTypes.BLOB in Sequelize → bytea in Postgres)
		CREATE TABLE attachments_blob (
			id int PRIMARY KEY, task_id int NOT NULL, name text NOT NULL,
			content_type text NOT NULL, size int NOT NULL, data bytea NOT NULL
		);
		-- path b: only metadata in the database; the bytes in object storage, found by storage_key
		CREATE TABLE attachments (
			id int PRIMARY KEY, task_id int NOT NULL, name text NOT NULL,
			content_type text NOT NULL, size int NOT NULL, storage_key text NOT NULL, etag text NOT NULL
		);
		ANALYZE tasks;`);
}

const storageKey = (f: FileSpec): string => `att/${f.id}`;

type Downloaded = { downloads: number[]; bytes: number };
type Phase = Downloaded & { name: string; oltp: number[] };
type Source = 'none' | 'db-app' | 'db-child' | 's3-app' | 's3-child';

// run the downloader in a child process and wait for 'ready'; returns the result's promise (the result arrives at the end of the phase)
async function startChild(source: 'db' | 's3'): Promise<Promise<Downloaded>> {
	const child = fork(path.join(__dirname, 'downloader.js'), [], {
		env: {
			...process.env,
			SOURCE: source,
			PHASE_MS: String(cfg.PHASE_MS),
			DOWNLOADERS: String(cfg.DOWNLOADERS),
			FILES: String(cfg.FILES),
			SEED: String(cfg.SEED)
		}
	});
	let onReady: () => void = () => undefined;
	const ready = new Promise<void>((resolve) => (onReady = resolve));
	const result = new Promise<Downloaded>((resolve, reject) => {
		child.on('message', (raw: unknown) => {
			const msg = messageSchema.parse(raw);
			if (msg.type === 'ready') onReady();
			else resolve({ downloads: msg.downloads, bytes: msg.bytes });
		});
		child.on('exit', (code) =>
			code === 0 ? undefined : reject(new Error(`downloader exited ${code}`))
		);
	});
	await ready;
	return result;
}

async function servePhase(pool: Pool, name: string, source: Source): Promise<Phase> {
	const child =
		source === 'db-child'
			? await startChild('db')
			: source === 's3-child'
				? await startChild('s3')
				: null;
	const deadline = Date.now() + cfg.PHASE_MS;
	const oltp: number[] = [];
	const downloads: number[] = [];
	let bytes = 0;
	let seed = 1;
	const random = mulberry32(cfg.SEED + 99);
	const oltpClient = async (): Promise<void> => {
		while (Date.now() < deadline) {
			const project = ((seed++ * 2654435761) % 5000) + 1;
			const t = performance.now();
			await pool.query(OLTP_SQL, [project]);
			oltp.push(performance.now() - t);
		}
	};
	// serving the file through the app: the same process (and for the database, the same pool) — when the file is in the database,
	// the app has to serve it this way; for object storage this is optional (a proxy)
	const appDownloader = async (): Promise<void> => {
		while (Date.now() < deadline) {
			const id = Math.floor(random() * cfg.FILES) + 1;
			const t = performance.now();
			if (source === 'db-app') {
				const res = await pool.query('SELECT data FROM attachments_blob WHERE id = $1', [id]);
				bytes += z.object({ data: z.instanceof(Buffer) }).parse(res.rows[0]).data.length;
			} else {
				const data = await getObject(env.BUCKET, `att/${id}`);
				bytes += data?.length ?? 0;
			}
			downloads.push(performance.now() - t);
		}
	};
	const inApp = source === 'db-app' || source === 's3-app';
	await Promise.all([
		...Array.from({ length: cfg.CLIENTS }, oltpClient),
		...Array.from({ length: inApp ? cfg.DOWNLOADERS : 0 }, appDownloader)
	]);
	if (child) {
		const r = await child;
		return { name, oltp, downloads: r.downloads, bytes: r.bytes };
	}
	return { name, oltp, downloads, bytes };
}

async function main(): Promise<void> {
	const pool = pgPool(cfg.POOL_MAX);
	await checkServices(pool);
	const files = fileSpecs();
	const total = files.reduce((sum, f) => sum + f.size, 0);
	console.log(
		`\n   ${cfg.FILES} files, ${mb(total)} in total · Postgres and object storage both on 2 CPUs\n`
	);

	await setup(pool);
	await emptyBucket(env.BUCKET);
	const contents = new Map(files.map((f) => [f.id, randomBytes(f.size)] as const));

	// ── step 1: storing ─────────────────────────────────────────
	let t = performance.now();
	const dbWal = await walBytes(pool, () =>
		inParallel(files, 4, async (f) => {
			await pool.query(
				'INSERT INTO attachments_blob (id, task_id, name, content_type, size, data) VALUES ($1, $2, $3, $4, $5, $6)',
				[f.id, f.taskId, f.name, 'application/pdf', f.size, contents.get(f.id)]
			);
		})
	);
	const dbMs = performance.now() - t;

	t = performance.now();
	const s3Wal = await walBytes(pool, () =>
		inParallel(files, 4, async (f) => {
			const body = contents.get(f.id);
			if (!body) return;
			// object first, then the metadata row — why this order is in §1.8 (dual write, 7.5)
			const etag = await putObject(env.BUCKET, storageKey(f), body, 'application/pdf');
			await pool.query(
				'INSERT INTO attachments (id, task_id, name, content_type, size, storage_key, etag) VALUES ($1, $2, $3, $4, $5, $6, $7)',
				[f.id, f.taskId, f.name, 'application/pdf', f.size, storageKey(f), etag]
			);
		})
	);
	const s3Ms = performance.now() - t;
	await pool.query('ANALYZE attachments_blob; ANALYZE attachments;');
	const blobTable = await relationSize(pool, 'attachments_blob');
	const metaTable = await relationSize(pool, 'attachments');
	const tasksTable = await relationSize(pool, 'tasks');

	console.log('── 1. Storing (4 uploads at a time) ─────────────────────────────');
	console.log(
		'   where                               time         WAL         DB growth    object storage'
	);
	console.log(
		`   Postgres (bytea)              ${ms(dbMs).padStart(10)}  ${mb(dbWal).padStart(10)}  ${mb(blobTable).padStart(16)}  ${'—'.padStart(16)}`
	);
	console.log(
		`   object storage + metadata row ${ms(s3Ms).padStart(10)}  ${mb(s3Wal).padStart(10)}  ${mb(metaTable).padStart(16)}  ${mb(total).padStart(16)}`
	);
	console.log(
		`   (for comparison: the whole tasks table of 200k tasks + indexes = ${mb(tasksTable)})\n`
	);

	// ── step 2: backup ──────────────────────────────────────────
	const full = await dump(false);
	const lean = await dump(true);
	console.log('── 2. Backup (pg_dump -Fc, inside the container) ─────────────────');
	console.log(
		`   ${'database with files'.padEnd(36)}${mb(full.bytes).padStart(10)}  ${ms(full.ms).padStart(9)}`
	);
	console.log(
		`   ${'without files (metadata only)'.padEnd(36)}${mb(lean.bytes).padStart(10)}  ${ms(lean.ms).padStart(9)}\n`
	);

	// ── step 3: OLTP while files are served ────────────────────
	await servePhase(pool, 'warm-up', 'none'); // so the first phase doesn't pay for a cold cache
	const phases = [
		await servePhase(pool, 'OLTP only', 'none'),
		await servePhase(pool, '+ files, Postgres → through the app', 'db-app'),
		await servePhase(pool, '+ files, Postgres → separate process', 'db-child'),
		...(cfg.PROXY_S3 === '1'
			? [await servePhase(pool, '+ files, object storage → through the app', 's3-app')]
			: []),
		await servePhase(pool, '+ files, object storage → direct', 's3-child')
	];
	console.log(
		`── 3. Board queries while files are served (${cfg.CLIENTS} OLTP clients, pool max ${cfg.POOL_MAX}; ${cfg.DOWNLOADERS} downloading files) ──`
	);
	console.log(
		'   step                                        OLTP q/s   OLTP p50   OLTP p99   file/s     MB/s   file p50 / p99'
	);
	for (const p of phases) {
		const secs = cfg.PHASE_MS / 1000;
		const dl = p.downloads.length
			? `${ms(percentile(p.downloads, 50))} / ${ms(percentile(p.downloads, 99))}`
			: '—';
		console.log(
			`   ${p.name.padEnd(43)} ${String(Math.round(p.oltp.length / secs)).padStart(8)} ${ms(percentile(p.oltp, 50)).padStart(10)} ${ms(percentile(p.oltp, 99)).padStart(10)} ${String(Math.round(p.downloads.length / secs)).padStart(8)} ${(p.bytes / 1024 / 1024 / secs).toFixed(0).padStart(8)}   ${dl}`
		);
	}
	console.log();
	await pool.end();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
