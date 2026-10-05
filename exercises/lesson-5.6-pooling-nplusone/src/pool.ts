import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { ConnectionAcquireTimeoutError } from 'sequelize';
import { DATABASE_URL, createSequelize, percentile } from './db';

// Lesson 5.6 — the connection pool's three questions, measured:
//   1. what does opening one connection cost?
//   2. is a bigger pool faster?
//   3. what happens when several app instances together exceed the database's connection limit?

// ── 1. A new connection vs the pool ─────────────────────────────────────────
async function connectionCost(): Promise<void> {
	const QUERIES = 200;
	console.log(`\n1. ${QUERIES} "SELECT 1" one at a time`);

	// a new connection for every query — TCP handshake + Postgres auth + a new backend process
	let started = performance.now();
	for (let i = 0; i < QUERIES; i++) {
		const client = new Client({ connectionString: DATABASE_URL });
		await client.connect();
		await client.query('SELECT 1');
		await client.end();
	}
	const fresh = (performance.now() - started) / QUERIES;

	// Pool — the connection is opened once, then reused again and again (like Lesson 1.4's keep-alive)
	const sequelize = createSequelize({ max: 1 });
	await sequelize.query('SELECT 1'); // open the connection in the pool once
	started = performance.now();
	for (let i = 0; i < QUERIES; i++) await sequelize.query('SELECT 1');
	const pooled = (performance.now() - started) / QUERIES;
	await sequelize.close();

	console.log(`   new connection every time   ${fresh.toFixed(2).padStart(7)} ms / query`);
	console.log(
		`   from the pool               ${pooled.toFixed(2).padStart(7)} ms / query   (~${(fresh / pooled).toFixed(0)}x faster)`
	);
}

// ── 2. Pool size sweep ──────────────────────────────────────────────────────
// 64 "requests" at once, 320 queries in total. Two kinds of query:
//   CPU   — the database really has to compute (the Postgres container has only 2 cores)
//   WAIT  — the database just waits (pg_sleep) — like a lock or a slow disk
const CALLERS = 64;
const TOTAL = 320;
const CPU_SQL = 'SELECT count(*) FROM generate_series(1, 400000)';
const WAIT_SQL = 'SELECT pg_sleep(0.02)';

type SweepResult = { qps: number; p50: number; p99: number };

async function sweep(poolMax: number, sql: string): Promise<SweepResult> {
	const sequelize = createSequelize({ max: poolMax, acquire: 120_000 });
	await Promise.all(Array.from({ length: poolMax }, () => sequelize.query('SELECT 1'))); // warm-up

	let remaining = TOTAL;
	const latencies: number[] = [];
	const caller = async (): Promise<void> => {
		while (remaining > 0) {
			remaining--;
			const started = performance.now();
			await sequelize.query(sql); // includes the time waiting for the pool — what the user sees
			latencies.push(performance.now() - started);
		}
	};
	const started = performance.now();
	await Promise.all(Array.from({ length: CALLERS }, caller));
	const seconds = (performance.now() - started) / 1000;
	await sequelize.close();

	latencies.sort((a, b) => a - b);
	return { qps: TOTAL / seconds, p50: percentile(latencies, 50), p99: percentile(latencies, 99) };
}

async function poolSizes(): Promise<void> {
	console.log(
		`\n2. Pool size — ${CALLERS} requests at once, ${TOTAL} queries in total (database: 2 CPU cores)`
	);
	console.log(
		'   pool max │   CPU query: q/s    p50 ms    p99 ms │  WAIT query: q/s    p50 ms    p99 ms'
	);
	for (const size of [1, 2, 4, 8, 16, 32, 64]) {
		const cpu = await sweep(size, CPU_SQL);
		const wait = await sweep(size, WAIT_SQL);
		const cell = (r: SweepResult): string =>
			`${r.qps.toFixed(0).padStart(8)} ${r.p50.toFixed(0).padStart(9)} ${r.p99.toFixed(0).padStart(9)}`;
		console.log(`   ${String(size).padStart(8)} │ ${cell(cpu)}        │ ${cell(wait)}`);
	}
}

// ── 3. Connection limit ─────────────────────────────────────────────────────
async function connectionLimit(): Promise<void> {
	const INSTANCES = 5;
	const PER_POOL = 25;
	console.log(
		`\n3. ${INSTANCES} app instances × pool max ${PER_POOL} = ${INSTANCES * PER_POOL} connections wanted (Postgres max_connections = 100)`
	);
	const instances = Array.from({ length: INSTANCES }, () => createSequelize({ max: PER_POOL }));
	const errors = new Map<string, number>();
	let ok = 0;
	await Promise.all(
		instances.flatMap((sequelize) =>
			Array.from({ length: PER_POOL }, async () => {
				try {
					await sequelize.query('SELECT pg_sleep(1)');
					ok++;
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					errors.set(message, (errors.get(message) ?? 0) + 1);
				}
			})
		)
	);
	console.log(`   succeeded: ${ok}`);
	for (const [message, count] of errors) console.log(`   failed: ${count} → "${message}"`);
	await Promise.all(instances.map((s) => s.close()));

	// When the pool itself runs out: max 2, yet 10 slow queries at once, and a 1 second wait limit
	console.log(
		"\n   when one instance's own pool runs out (max 2, acquire timeout 1s, 10 queries of 0.8s):"
	);
	const small = createSequelize({ max: 2, acquire: 1_000 });
	let served = 0;
	let timedOut = 0;
	await Promise.all(
		Array.from({ length: 10 }, async () => {
			try {
				await small.query('SELECT pg_sleep(0.8)');
				served++;
			} catch (error: unknown) {
				if (error instanceof ConnectionAcquireTimeoutError) timedOut++;
				else throw error;
			}
		})
	);
	await small.close();
	console.log(`   succeeded: ${served}, ConnectionAcquireTimeoutError: ${timedOut}`);
}

async function main(): Promise<void> {
	const only = process.argv[2];
	if (!only || only === '1') await connectionCost();
	if (!only || only === '2') await poolSizes();
	if (!only || only === '3') await connectionLimit();
	console.log('');
}

main().catch((error: unknown): void => {
	console.error('pool failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
