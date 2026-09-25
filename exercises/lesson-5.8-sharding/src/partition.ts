import { performance } from 'node:perf_hooks';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { closeAll, scalar, shardAt } from './db';

// Lesson 5.8 §১.২ — একটা database এর ভেতরে partitioning (Postgres declarative partitioning)।
// TaskFlow এর activity log — ১২ মাস, মাসে ১ লাখ event। একই data দুটো table এ:
//   activity_plain — সাধারণ একটা table
//   activity       — মাস অনুযায়ী ১২টা partition এ ভাগ করা
// Sequelize partitioned table বানাতে পারে না — তাই DDL raw SQL এ (migration এও তাই লিখতে হয়)।

const db = shardAt(0);
const MONTHS = 12;
const PER_MONTH = 100_000;
const FIRST_MONTH = '2025-10-01';

function monthStart(offset: number): string {
	const d = new Date(`${FIRST_MONTH}T00:00:00Z`);
	d.setUTCMonth(d.getUTCMonth() + offset);
	return d.toISOString().slice(0, 10);
}

function partitionName(offset: number): string {
	return `activity_${monthStart(offset).slice(0, 7).replace('-', '_')}`;
}

async function setup(): Promise<void> {
	await db.query('DROP TABLE IF EXISTS activity_plain, activity CASCADE');
	const columns = `
		id bigserial,
		"projectId" integer NOT NULL,
		action text NOT NULL,
		"createdAt" timestamptz NOT NULL`;
	await db.query(`CREATE TABLE activity_plain (${columns}, PRIMARY KEY (id))`);
	// Partitioned table এ primary key তে partition key থাকতেই হয় — Postgres এর নিয়ম
	await db.query(
		`CREATE TABLE activity (${columns}, PRIMARY KEY (id, "createdAt")) PARTITION BY RANGE ("createdAt")`
	);
	for (let m = 0; m < MONTHS; m++) {
		await db.query(
			`CREATE TABLE ${partitionName(m)} PARTITION OF activity
			 FOR VALUES FROM ('${monthStart(m)}') TO ('${monthStart(m + 1)}')`
		);
	}
	// একই index দুই জায়গায় — partitioned table এ দিলে প্রতিটা partition এ নিজে থেকে তৈরি হয়
	await db.query('CREATE INDEX ON activity_plain ("projectId", "createdAt")');
	await db.query('CREATE INDEX ON activity ("projectId", "createdAt")');

	const seconds = MONTHS * 30 * 24 * 3600;
	const insert = (table: string): string => `
		INSERT INTO ${table} ("projectId", action, "createdAt")
		SELECT 1 + (g % 500), 'moved task',
		       timestamptz '${FIRST_MONTH} 00:00:00+00' + ((g::float / ${MONTHS * PER_MONTH}) * ${seconds}) * interval '1 second'
		FROM generate_series(0, ${MONTHS * PER_MONTH - 1}) g`;
	await db.query(insert('activity_plain'));
	await db.query(insert('activity'));
	await db.query('VACUUM ANALYZE activity_plain');
	await db.query('VACUUM ANALYZE activity');
}

// EXPLAIN এর JSON গাছে কোন কোন table/partition ছোঁয়া হলো
type PlanNode = { 'Relation Name'?: string | undefined; Plans?: PlanNode[] | undefined };
const planNode: z.ZodType<PlanNode> = z.lazy(() =>
	z.object({ 'Relation Name': z.string().optional(), Plans: z.array(planNode).optional() })
);
const explainRows = z
	.array(
		z.object({ 'QUERY PLAN': z.array(z.object({ Plan: planNode, 'Execution Time': z.number() })) })
	)
	.length(1);

function relations(node: PlanNode, into: Set<string>): Set<string> {
	if (node['Relation Name']) into.add(node['Relation Name']);
	for (const child of node.Plans ?? []) relations(child, into);
	return into;
}

async function explain(sql: string): Promise<{ touched: string[]; ms: number }> {
	await db.query(sql); // warm-up
	const result = explainRows.parse(
		await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, { type: QueryTypes.SELECT })
	);
	const top = result[0]?.['QUERY PLAN'][0];
	if (!top) throw new Error('no plan');
	return { touched: [...relations(top.Plan, new Set())].sort(), ms: top['Execution Time'] };
}

function describeTouched(touched: string[]): string {
	return touched.length > 2 ? `${touched.length}টা partition` : touched.join(', ');
}

async function walSince(lsn: string): Promise<number> {
	return scalar(db, 'SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), :lsn) AS v', { lsn });
}

async function currentLsn(): Promise<string> {
	const rows = z
		.array(z.object({ v: z.string() }))
		.length(1)
		.parse(await db.query('SELECT pg_current_wal_lsn()::text AS v', { type: QueryTypes.SELECT }));
	return rows[0]?.v ?? '0/0';
}

async function main(): Promise<void> {
	const started = performance.now();
	await setup();
	console.log(
		`\n  ${MONTHS} মাস × ${PER_MONTH.toLocaleString('en-US')} = ${(MONTHS * PER_MONTH).toLocaleString('en-US')}টা activity, দুটো table এ (${((performance.now() - started) / 1000).toFixed(1)}s)`
	);

	console.log('\n১. Partition pruning — query কোন partition ছোঁয়?');
	const queries: [string, string][] = [
		[
			'project 42, শেষ ৭ দিন',
			`SELECT count(*) FROM {t} WHERE "projectId" = 42 AND "createdAt" >= '2026-09-23'`
		],
		['project 42, সব সময় (সময়ের শর্ত নেই)', `SELECT count(*) FROM {t} WHERE "projectId" = 42`],
		[
			'পুরো মাসের সব event (আগস্ট)',
			`SELECT count(*) FROM {t} WHERE "createdAt" >= '2026-08-01' AND "createdAt" < '2026-09-01'`
		]
	];
	console.log(`   ${'query'.padEnd(38)} ${'সাধারণ table'.padEnd(26)} partitioned`);
	for (const [label, template] of queries) {
		const plain = await explain(template.replace('{t}', 'activity_plain'));
		const parted = await explain(template.replace('{t}', 'activity'));
		console.log(
			`   ${label.padEnd(38)} ${`${plain.ms.toFixed(2)} ms`.padEnd(26)} ${parted.ms.toFixed(2)} ms — ${describeTouched(parted.touched)}`
		);
	}

	console.log('\n২. Retention — সবচেয়ে পুরনো মাস (অক্টোবর ২০২৫) মুছে ফেলা');
	const plainBefore = await scalar(db, `SELECT pg_total_relation_size('activity_plain') AS v`);

	let lsn = await currentLsn();
	let t0 = performance.now();
	// DELETE এর metadata তে pg এর `rowCount` থাকে — type এ unknown, তাই Zod দিয়ে পড়া
	const [, meta] = await db.query(
		`DELETE FROM activity_plain WHERE "createdAt" < '${monthStart(1)}'`
	);
	const deleted = z.object({ rowCount: z.number() }).parse(meta).rowCount;
	const deleteMs = performance.now() - t0;
	const deleteWal = await walSince(lsn);
	const plainAfter = await scalar(db, `SELECT pg_total_relation_size('activity_plain') AS v`);

	lsn = await currentLsn();
	t0 = performance.now();
	await db.query(`ALTER TABLE activity DETACH PARTITION ${partitionName(0)}`);
	await db.query(`DROP TABLE ${partitionName(0)}`);
	const dropMs = performance.now() - t0;
	const dropWal = await walSince(lsn);

	const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	console.log(
		`   সাধারণ table: DELETE (${deleted.toLocaleString('en-US')} row)   ${deleteMs.toFixed(0).padStart(6)} ms   WAL ${mb(deleteWal).padStart(9)}   table এর আকার ${mb(plainBefore)} → ${mb(plainAfter)}`
	);
	console.log(
		`   partitioned:  DETACH + DROP partition   ${dropMs.toFixed(0).padStart(6)} ms   WAL ${mb(dropWal).padStart(9)}   (পুরো file টাই মুছে গেল)`
	);
	console.log('');
	await closeAll();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('partition failed:', error instanceof Error ? error.message : String(error));
	await closeAll();
	process.exit(1);
});
