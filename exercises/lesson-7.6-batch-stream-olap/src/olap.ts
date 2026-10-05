import { z } from 'zod';
import { ANALYTICS_SQL, CHECKSUM_SQL, duck, OLTP_SQL, pgPool } from './data';
import { percentile } from './random';

// Lesson 7.6 §1.2–1.3 — OLTP and OLAP in one database, and in separate engines.
//
//   step 1: OLTP only — CLIENTS clients keep asking "the project's 20 most recent events"
//   step 2: the same OLTP, plus ANALYTICS_LOOPS analytics queries running nonstop on the same Postgres
//   step 3: the analytics question once on Postgres (alone), once on DuckDB — comparing times and results
//
// A real database, real time — the numbers will vary between machines, the shape should stay the same.

const env = z
	.object({
		PHASE_MS: z.coerce.number().int().positive().default(10_000),
		CLIENTS: z.coerce.number().int().positive().default(8),
		ANALYTICS_LOOPS: z.coerce.number().int().nonnegative().default(4)
	})
	.parse(process.env);

const fmt = (ms: number): string =>
	ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;

async function main(): Promise<void> {
	const pool = pgPool(env.CLIENTS + env.ANALYTICS_LOOPS + 2);
	try {
		await pool.query('SELECT 1 FROM task_events LIMIT 1');
	} catch {
		console.error(
			'task_events is missing — run `docker compose up -d --wait` and `npm run seed` first.'
		);
		process.exit(1);
	}

	type Phase = { name: string; oltp: number[]; analytics: number[] };

	async function phase(name: string, analyticsLoops: number): Promise<Phase> {
		const deadline = Date.now() + env.PHASE_MS;
		const oltp: number[] = [];
		const analytics: number[] = [];
		let seed = 1;
		const oltpClient = async (): Promise<void> => {
			while (Date.now() < deadline) {
				const project = ((seed++ * 2654435761) % 5000) + 1;
				const t = performance.now();
				await pool.query(OLTP_SQL, [project]);
				oltp.push(performance.now() - t);
			}
		};
		const analyticsClient = async (): Promise<void> => {
			while (Date.now() < deadline) {
				const t = performance.now();
				await pool.query(ANALYTICS_SQL);
				analytics.push(performance.now() - t);
			}
		};
		await Promise.all([
			...Array.from({ length: env.CLIENTS }, oltpClient),
			...Array.from({ length: analyticsLoops }, analyticsClient)
		]);
		return { name, oltp, analytics };
	}

	console.log(
		`\n   Postgres (2 CPUs) · ${env.CLIENTS} OLTP clients · ${env.PHASE_MS / 1000} s per phase\n`
	);
	// warm up once — so the first phase doesn't pay for a cold cache
	await pool.query(ANALYTICS_SQL);
	const phases = [
		await phase('OLTP only', 0),
		await phase(`OLTP + ${env.ANALYTICS_LOOPS} analytics`, env.ANALYTICS_LOOPS)
	];

	console.log(
		'   phase                           OLTP q/s   OLTP p50    OLTP p99   OLTP max    analytics done (avg)'
	);
	for (const p of phases) {
		const qps = p.oltp.length / (env.PHASE_MS / 1000);
		const avg = p.analytics.length
			? p.analytics.reduce((a, b) => a + b, 0) / p.analytics.length
			: 0;
		console.log(
			`   ${p.name.padEnd(28)}${qps.toFixed(0).padStart(12)}${fmt(percentile(p.oltp, 50)).padStart(11)}${fmt(percentile(p.oltp, 99)).padStart(12)}${fmt(p.oltp.reduce((a, b) => Math.max(a, b), 0)).padStart(11)}${(p.analytics.length ? `${p.analytics.length} times (${fmt(avg)})` : '—').padStart(24)}`
		);
	}

	// ── step 3: the same question, two engines ─────────────────────────────────────────
	const time = async (run: () => Promise<unknown>): Promise<number> => {
		const t = performance.now();
		await run();
		return performance.now() - t;
	};
	const pgTimes: number[] = [];
	for (let i = 0; i < 3; i++) pgTimes.push(await time(() => pool.query(ANALYTICS_SQL)));
	const plan = await pool.query<{ 'QUERY PLAN': string }>(
		`EXPLAIN (ANALYZE, BUFFERS) ${ANALYTICS_SQL}`
	);
	const planText = plan.rows.map((r) => r['QUERY PLAN']);
	const scan = planText.find((l) => l.includes('Seq Scan')) ?? '';
	const buffers = planText.find((l) => l.includes('Buffers:')) ?? '';

	const con = await duck();
	// DuckDB runs inside this process and by default takes every core on the machine — to keep the comparison honest, 2 like Postgres
	await con.run('SET threads = 2');
	const duckTimes: number[] = [];
	for (let i = 0; i < 3; i++) duckTimes.push(await time(() => con.runAndReadAll(ANALYTICS_SQL)));
	const pgSum = (await pool.query<{ rows: string; ms: string }>(CHECKSUM_SQL)).rows[0];
	const dSum = (await con.runAndReadAll(CHECKSUM_SQL)).getRowObjects()[0];

	console.log(
		'\n   the same analytics question (monthly usage, per workspace), nothing else running, three times each:'
	);
	console.log(`     Postgres (row store, 2 CPUs):       ${pgTimes.map(fmt).join(', ')}`);
	console.log(`     DuckDB   (column store, 2 threads):  ${duckTimes.map(fmt).join(', ')}`);
	console.log(
		`     results match: ${String(pgSum?.rows) === String(dSum?.['rows']) && String(pgSum?.ms) === String(dSum?.['ms']) ? 'yes ✓' : 'no ✗'}`
	);
	console.log(`\n   from Postgres's plan:\n     ${scan.trim()}\n     ${buffers.trim()}`);
	con.closeSync();
	await pool.end();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
