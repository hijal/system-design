import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { ConnectionAcquireTimeoutError } from 'sequelize';
import { DATABASE_URL, createSequelize, percentile } from './db';

// Lesson 5.6 — connection pool এর তিনটা প্রশ্ন, মেপে:
//   ১. একটা connection খোলার দাম কত?
//   ২. Pool যত বড়, তত দ্রুত?
//   ৩. কয়েকটা app instance মিলে database এর connection limit ছাড়ালে কী হয়?

// ── ১. নতুন connection বনাম pool ─────────────────────────────────────────────
async function connectionCost(): Promise<void> {
	const QUERIES = 200;
	console.log(`\n১. একটা একটা করে ${QUERIES}টা "SELECT 1"`);

	// প্রতিটা query তে নতুন connection — TCP handshake + Postgres auth + নতুন backend process
	let started = performance.now();
	for (let i = 0; i < QUERIES; i++) {
		const client = new Client({ connectionString: DATABASE_URL });
		await client.connect();
		await client.query('SELECT 1');
		await client.end();
	}
	const fresh = (performance.now() - started) / QUERIES;

	// Pool — connection একবার খোলা, তারপর বারবার ব্যবহার (Lesson 1.4 এর keep-alive এর মতো)
	const sequelize = createSequelize({ max: 1 });
	await sequelize.query('SELECT 1'); // pool এ connection টা একবার খুলে রাখা
	started = performance.now();
	for (let i = 0; i < QUERIES; i++) await sequelize.query('SELECT 1');
	const pooled = (performance.now() - started) / QUERIES;
	await sequelize.close();

	console.log(`   প্রতিবার নতুন connection   ${fresh.toFixed(2).padStart(7)} ms / query`);
	console.log(
		`   pool থেকে                   ${pooled.toFixed(2).padStart(7)} ms / query   (~${(fresh / pooled).toFixed(0)}x দ্রুত)`
	);
}

// ── ২. Pool size sweep ───────────────────────────────────────────────────────
// ৬৪টা "request" একসাথে, মোট ৩২০টা query। দুই ধরনের query:
//   CPU   — database কে সত্যিই হিসাব করতে হয় (Postgres container এ মাত্র ২টা core)
//   WAIT  — database শুধু অপেক্ষা করে (pg_sleep) — lock বা ধীর disk এর মতো
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
			await sequelize.query(sql); // pool এ অপেক্ষার সময়ও এর ভেতরে — user এর চোখে যা দেখায়
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
		`\n২. Pool size — ${CALLERS}টা request একসাথে, মোট ${TOTAL}টা query (database: ২টা CPU core)`
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

// ── ৩. Connection limit ──────────────────────────────────────────────────────
async function connectionLimit(): Promise<void> {
	const INSTANCES = 5;
	const PER_POOL = 25;
	console.log(
		`\n৩. ${INSTANCES}টা app instance × pool max ${PER_POOL} = ${INSTANCES * PER_POOL} connection চাই (Postgres max_connections = 100)`
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
	console.log(`   সফল: ${ok}টা`);
	for (const [message, count] of errors) console.log(`   ব্যর্থ: ${count}টা → "${message}"`);
	await Promise.all(instances.map((s) => s.close()));

	// Pool নিজে শেষ হয়ে গেলে: max ২, অথচ ১০টা ধীর query একসাথে, আর অপেক্ষার সীমা ১ সেকেন্ড
	console.log(
		'\n   একটা instance এর pool নিজেই ফুরিয়ে গেলে (max 2, acquire timeout 1s, ১০টা ০.৮s এর query):'
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
	console.log(`   সফল: ${served}টা, ConnectionAcquireTimeoutError: ${timedOut}টা`);
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
