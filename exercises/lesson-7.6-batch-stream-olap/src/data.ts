import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import path from 'node:path';
import { Pool } from 'pg';
import { z } from 'zod';

// Lesson 7.6 — দুটো engine এ হুবহু একই data: TaskFlow এর এক বছরের task_events।
// প্রতিটা column একটা নির্দিষ্ট সূত্রে i থেকে তৈরি — তাই Postgres আর DuckDB এ একই row, আর দুটোর
// ফলাফল মিলিয়ে দেখা যায় (checksum)।

export const env = z
	.object({
		DATABASE_URL: z.string().default('postgres://taskflow:taskflow@localhost:5444/taskflow'),
		ROWS: z.coerce.number().int().positive().default(3_000_000)
	})
	.parse(process.env);

export const DUCKDB_FILE = path.join(__dirname, '..', 'data', 'analytics.duckdb');

export function pgPool(max = 20): Pool {
	return new Pool({ connectionString: env.DATABASE_URL, max });
}

export async function duck(): Promise<DuckDBConnection> {
	const instance = await DuckDBInstance.create(DUCKDB_FILE);
	return instance.connect();
}

// i (1..ROWS) থেকে প্রতিটা column — দুই dialect এ একই গণিত
const columns = (ts: string): string => `
	i AS id,
	(i * 7919) % 200 + 1 AS workspace_id,
	(i * 104729) % 5000 + 1 AS project_id,
	(i * 1299709) % 1000000 + 1 AS task_id,
	(i * 15485863) % 20000 + 1 AS user_id,
	CASE i % 4 WHEN 0 THEN 'task.created' WHEN 1 THEN 'task.assigned'
	           WHEN 2 THEN 'comment.created' ELSE 'task.completed' END AS type,
	${ts} AS occurred_at,
	(i * 31) % 100000 AS duration_ms`;

export const pgSeedSql = (rows: number): string => `
	DROP TABLE IF EXISTS task_events;
	CREATE TABLE task_events (
		id bigint PRIMARY KEY,
		workspace_id int NOT NULL,
		project_id int NOT NULL,
		task_id int NOT NULL,
		user_id int NOT NULL,
		type text NOT NULL,
		occurred_at timestamp NOT NULL,
		duration_ms int NOT NULL
	);
	INSERT INTO task_events
	SELECT ${columns("TIMESTAMP '2025-01-01' + ((i * 7) % 31536000) * INTERVAL '1 second'")}
	FROM generate_series(1::bigint, ${rows}::bigint) AS i;
	-- OLTP এর index: "এই project এর সাম্প্রতিক ঘটনা"
	CREATE INDEX task_events_project_recent ON task_events (project_id, occurred_at DESC);
	ANALYZE task_events;`;

export const duckSeedSql = (rows: number): string => `
	CREATE OR REPLACE TABLE task_events AS
	SELECT ${columns("TIMESTAMP '2025-01-01' + to_seconds(((i * 7) % 31536000)::BIGINT)")}
	FROM generate_series(1::BIGINT, ${rows}::BIGINT) AS t(i);`;

// Analytics এর প্রশ্ন: "প্রতিটা workspace এ প্রতি মাসে কয়টা task complete হলো, মোট কত সময়"
// — finance এর মাসিক usage report। পুরো table ঘুরতে হয়, কিন্তু আটটার মধ্যে মাত্র তিনটা column লাগে।
export const ANALYTICS_SQL = `
	SELECT workspace_id, date_trunc('month', occurred_at) AS month,
	       count(*) AS completed, sum(duration_ms) AS total_ms
	FROM task_events
	WHERE type = 'task.completed'
	GROUP BY workspace_id, date_trunc('month', occurred_at)`;

// দুই engine এর ফল মেলানোর জন্য একটা সংখ্যা
export const CHECKSUM_SQL = `SELECT sum(completed) AS rows, sum(total_ms) AS ms FROM (${ANALYTICS_SQL}) AS r`;

// OLTP এর প্রশ্ন: একটা project এর board খুললে "সাম্প্রতিক ২০টা ঘটনা"
export const OLTP_SQL = `
	SELECT id, task_id, type, occurred_at
	FROM task_events
	WHERE project_id = $1
	ORDER BY occurred_at DESC
	LIMIT 20`;
