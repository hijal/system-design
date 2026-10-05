import { commentText, env, pgPool } from './data';

// Lesson 8.3 — ROWS comments in Postgres (1,000,000 by default). No indexes — like.ts builds and drops them itself.

const BATCH = 1000;

async function main(): Promise<void> {
	const pool = pgPool(4);
	try {
		await pool.query('SELECT 1');
	} catch {
		console.error('Postgres cannot be reached — run `docker compose up -d --wait` first.');
		process.exit(1);
	}
	const t = performance.now();
	await pool.query(`
		DROP TABLE IF EXISTS comments;
		CREATE TABLE comments (id int PRIMARY KEY, task_id int NOT NULL, body text NOT NULL);`);

	let next = 1;
	const worker = async (): Promise<void> => {
		while (next <= env.ROWS) {
			const start = next;
			next += BATCH;
			const end = Math.min(env.ROWS, start + BATCH - 1);
			const values: string[] = [];
			const params: (number | string)[] = [];
			for (let i = start; i <= end; i++) {
				const p = params.length;
				values.push(`($${p + 1}, $${p + 2}, $${p + 3})`);
				params.push(i, ((i * 7919) % 200_000) + 1, commentText(i));
			}
			await pool.query(
				`INSERT INTO comments (id, task_id, body) VALUES ${values.join(',')}`,
				params
			);
		}
	};
	await Promise.all(Array.from({ length: 4 }, worker));
	await pool.query('VACUUM ANALYZE comments');
	const size = await pool.query(
		"SELECT pg_size_pretty(pg_total_relation_size('comments')) AS size"
	);
	console.log(
		`\n   ${env.ROWS.toLocaleString('en')} comments · table ${String(size.rows[0]?.size)} · ${((performance.now() - t) / 1000).toFixed(1)} s`
	);
	console.log(`   example: "${commentText(1)}"\n`);
	await pool.end();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
