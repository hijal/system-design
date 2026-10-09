import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CHECKSUM_SQL, duck, DUCKDB_FILE, duckSeedSql, env, pgPool, pgSeedSql } from './data';

// Lesson 7.6 - the same ROWS events in two places: Postgres (row store, TaskFlow's production database)
// and DuckDB (column store, analytics). Then the analytics question's result is compared across both.

async function main(): Promise<void> {
	const rows = env.ROWS;
	console.log(`   generating ${rows.toLocaleString('en-US')} task events…`);

	const pool = pgPool(2);
	let t = Date.now();
	await pool.query(pgSeedSql(rows));
	const size = await pool.query<{ table: string; total: string }>(
		`SELECT pg_size_pretty(pg_table_size('task_events')) AS table,
		        pg_size_pretty(pg_total_relation_size('task_events')) AS total`
	);
	console.log(
		`   Postgres: ${((Date.now() - t) / 1000).toFixed(1)} s · table ${size.rows[0]?.table} (with indexes ${size.rows[0]?.total})`
	);

	rmSync(DUCKDB_FILE, { force: true });
	rmSync(`${DUCKDB_FILE}.wal`, { force: true });
	mkdirSync(path.dirname(DUCKDB_FILE), { recursive: true });
	const con = await duck();
	t = Date.now();
	await con.run(duckSeedSql(rows));
	await con.run('CHECKPOINT');
	const dsize = await con.runAndReadAll(
		`SELECT sum(total_blocks * block_size) AS bytes FROM pragma_database_size()`
	);
	const bytes = Number(dsize.getRowObjects()[0]?.['bytes'] ?? 0);
	console.log(
		`   DuckDB:   ${((Date.now() - t) / 1000).toFixed(1)} s · file ${(bytes / 1024 / 1024).toFixed(0)} MB`
	);

	const pgSum = (await pool.query<{ rows: string; ms: string }>(CHECKSUM_SQL)).rows[0];
	const dSum = (await con.runAndReadAll(CHECKSUM_SQL)).getRowObjects()[0];
	const same =
		String(pgSum?.rows) === String(dSum?.['rows']) && String(pgSum?.ms) === String(dSum?.['ms']);
	console.log(
		`   checksum: Postgres ${pgSum?.rows} / ${pgSum?.ms} · DuckDB ${String(dSum?.['rows'])} / ${String(dSum?.['ms'])} → ${same ? 'match ✓' : 'mismatch ✗'}`
	);
	con.closeSync();
	await pool.end();
	if (!same) process.exit(1);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	console.error('Is Postgres running? `docker compose up -d --wait`');
	process.exit(1);
});
