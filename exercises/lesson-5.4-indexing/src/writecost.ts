import { performance } from 'node:perf_hooks';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from './db';

// Lesson 5.4 §১.৬ — index এর দাম লেখার সময় দিতে হয়।
// একই ২ লাখ row insert করা হয় তিনটা table এ: শুধু primary key, ৩টা index, ৬টা index।
// মাপা হয় সময়, আর কত byte WAL লেখা হলো (Lesson 5.3 এর write amplification)।

const ROWS = 200_000;
const ROUNDS = 3;

const INDEXES: string[] = [
	'CREATE INDEX ON tasks_w ("assigneeId")',
	'CREATE INDEX ON tasks_w ("projectId", "createdAt")',
	'CREATE INDEX ON tasks_w ("createdAt")',
	'CREATE INDEX ON tasks_w (status)',
	'CREATE INDEX ON tasks_w (lower(title))',
	'CREATE INDEX ON tasks_w (title text_pattern_ops)'
];

const lsnRows = z.array(z.object({ lsn: z.string() }));
const diffRows = z.array(z.object({ bytes: z.coerce.number() }));
const sizeRows = z.array(z.object({ size: z.coerce.number() }));

async function currentLsn(): Promise<string> {
	const rows = lsnRows.parse(
		await sequelize.query('SELECT pg_current_wal_lsn()::text AS lsn', { type: QueryTypes.SELECT })
	);
	const lsn = rows[0]?.lsn;
	if (!lsn) throw new Error('no LSN');
	return lsn;
}

async function walBytesSince(lsn: string): Promise<number> {
	const rows = diffRows.parse(
		await sequelize.query('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), :lsn) AS bytes', {
			replacements: { lsn },
			type: QueryTypes.SELECT
		})
	);
	return rows[0]?.bytes ?? 0;
}

async function indexesBytes(): Promise<number> {
	const rows = sizeRows.parse(
		await sequelize.query(`SELECT pg_indexes_size('tasks_w') AS size`, { type: QueryTypes.SELECT })
	);
	return rows[0]?.size ?? 0;
}

type Result = { ms: number; walMb: number; indexMb: number };

async function measure(indexCount: number): Promise<Result> {
	await sequelize.query('DROP TABLE IF EXISTS tasks_w');
	await sequelize.query('CREATE TABLE tasks_w (LIKE tasks INCLUDING ALL)'); // primary key সহ
	for (const ddl of INDEXES.slice(0, indexCount)) await sequelize.query(ddl);

	const times: number[] = [];
	const wal: number[] = [];
	for (let i = 0; i < ROUNDS; i++) {
		await sequelize.query('TRUNCATE tasks_w');
		const lsn = await currentLsn();
		const started = performance.now();
		await sequelize.query(
			`INSERT INTO tasks_w ("projectId", "assigneeId", title, status, "createdAt")
			 SELECT "projectId", "assigneeId", title, status, "createdAt" FROM tasks WHERE id <= ${ROWS}`
		);
		times.push(performance.now() - started);
		wal.push(await walBytesSince(lsn));
	}
	times.sort((a, b) => a - b);
	wal.sort((a, b) => a - b);
	const mid = Math.floor(ROUNDS / 2);
	return {
		ms: times[mid] ?? 0,
		walMb: (wal[mid] ?? 0) / 1024 / 1024,
		indexMb: (await indexesBytes()) / 1024 / 1024
	};
}

async function main(): Promise<void> {
	console.log(`\n  ${ROWS.toLocaleString('en-US')} row insert, ${ROUNDS} বারের median:\n`);
	console.log('  index (primary key বাদে)      সময়        WAL       index এর মোট আকার');
	let base: Result | undefined;
	for (const count of [0, 3, 6]) {
		const result = await measure(count);
		base ??= result;
		const slower = (result.ms / base.ms).toFixed(1);
		console.log(
			`  ${String(count).padStart(2)}টা${' '.repeat(24)}${result.ms.toFixed(0).padStart(6)} ms (${slower}x)  ${result.walMb.toFixed(1).padStart(6)} MB   ${result.indexMb.toFixed(1).padStart(6)} MB`
		);
	}
	await sequelize.query('DROP TABLE IF EXISTS tasks_w');
	console.log('');
	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('writecost failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
