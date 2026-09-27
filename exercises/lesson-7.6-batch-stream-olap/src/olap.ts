import { z } from 'zod';
import { ANALYTICS_SQL, CHECKSUM_SQL, duck, OLTP_SQL, pgPool } from './data';
import { percentile } from './random';

// Lesson 7.6 §১.২–১.৩ — OLTP আর OLAP এক database এ, আর আলাদা engine এ।
//
//   ধাপ ১: শুধু OLTP — CLIENTS টা client একটানা "project এর সাম্প্রতিক ২০টা ঘটনা" জিজ্ঞেস করে
//   ধাপ ২: একই OLTP, আর একই Postgres এ ANALYTICS_LOOPS টা analytics query একটানা চলে
//   ধাপ ৩: analytics এর প্রশ্ন একবার Postgres এ (একা), একবার DuckDB তে — সময় আর ফল মেলানো
//
// আসল database, আসল সময় — সংখ্যা মেশিন ভেদে বদলাবে, আকৃতি একই থাকার কথা।

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
		console.error('task_events নেই — আগে `docker compose up -d --wait` আর `npm run seed`।');
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
		`\n   Postgres (২টা CPU) · ${env.CLIENTS} টা OLTP client · প্রতি ধাপ ${env.PHASE_MS / 1000} s\n`
	);
	// একবার গরম করে নেওয়া — প্রথম ধাপ যাতে ঠান্ডা cache এর দাম না দেয়
	await pool.query(ANALYTICS_SQL);
	const phases = [
		await phase('শুধু OLTP', 0),
		await phase(`OLTP + ${env.ANALYTICS_LOOPS}টা analytics`, env.ANALYTICS_LOOPS)
	];

	console.log(
		'   ধাপ                          OLTP query/s   OLTP p50    OLTP p99    OLTP max   analytics শেষ হলো (গড়)'
	);
	for (const p of phases) {
		const qps = p.oltp.length / (env.PHASE_MS / 1000);
		const avg = p.analytics.length
			? p.analytics.reduce((a, b) => a + b, 0) / p.analytics.length
			: 0;
		console.log(
			`   ${p.name.padEnd(28)}${qps.toFixed(0).padStart(12)}${fmt(percentile(p.oltp, 50)).padStart(11)}${fmt(percentile(p.oltp, 99)).padStart(12)}${fmt(p.oltp.reduce((a, b) => Math.max(a, b), 0)).padStart(11)}${(p.analytics.length ? `${p.analytics.length} বার (${fmt(avg)})` : '—').padStart(24)}`
		);
	}

	// ── ধাপ ৩: একই প্রশ্ন, দুই engine ─────────────────────────────────────────────────
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
	// DuckDB এই process এর ভেতরে চলে আর default এ মেশিনের সব core নেয় — তুলনা সৎ রাখতে Postgres এর মতো ২টা
	await con.run('SET threads = 2');
	const duckTimes: number[] = [];
	for (let i = 0; i < 3; i++) duckTimes.push(await time(() => con.runAndReadAll(ANALYTICS_SQL)));
	const pgSum = (await pool.query<{ rows: string; ms: string }>(CHECKSUM_SQL)).rows[0];
	const dSum = (await con.runAndReadAll(CHECKSUM_SQL)).getRowObjects()[0];

	console.log(
		'\n   একই analytics প্রশ্ন (মাসিক usage, workspace ধরে), কেউ আর চলছে না, তিনবার করে:'
	);
	console.log(`     Postgres (row store, ২ CPU):       ${pgTimes.map(fmt).join(', ')}`);
	console.log(`     DuckDB   (column store, ২ thread):  ${duckTimes.map(fmt).join(', ')}`);
	console.log(
		`     ফল মিলেছে: ${String(pgSum?.rows) === String(dSum?.['rows']) && String(pgSum?.ms) === String(dSum?.['ms']) ? 'হ্যাঁ ✓' : 'না ✗'}`
	);
	console.log(`\n   Postgres এর plan থেকে:\n     ${scan.trim()}\n     ${buffers.trim()}`);
	con.closeSync();
	await pool.end();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
