import { performance } from 'node:perf_hooks';
import { QueryTypes, type Sequelize } from 'sequelize';
import { z } from 'zod';
import { closeAll, scalar, shardAt, shards } from './db';
import { moduloShard } from './hash';

// Lesson 5.8 §1.3–1.6 — splitting TaskFlow across 3 databases, shard key = workspaceId.
// All of a workspace's data is on one shard — so all the work inside a workspace is in one place.

const WORKSPACES = 300;
const TASKS = 300_000;
const BIG_WORKSPACE = 7; // a huge enterprise customer — 40% of all tasks
const BIG_SHARE = 0.4;

function shardFor(workspaceId: number): Sequelize {
	return shardAt(moduloShard(`ws:${workspaceId}`, shards.length));
}

function shardIndexFor(workspaceId: number): number {
	return moduloShard(`ws:${workspaceId}`, shards.length);
}

async function setup(): Promise<void> {
	// the same schema on every shard
	for (const shard of shards) {
		await shard.query('DROP TABLE IF EXISTS tasks, projects');
		await shard.query(`CREATE TABLE projects (
			id integer PRIMARY KEY, "workspaceId" integer NOT NULL, name text NOT NULL)`);
		await shard.query(`CREATE TABLE tasks (
			id bigint PRIMARY KEY, "workspaceId" integer NOT NULL, "projectId" integer NOT NULL,
			status text NOT NULL)`);
		await shard.query('CREATE INDEX ON tasks ("workspaceId", status)');
	}

	// one project per workspace; tasks spread across workspaces — 40% in one
	const bigCount = Math.floor(TASKS * BIG_SHARE);
	const perOther = Math.floor((TASKS - bigCount) / (WORKSPACES - 1));
	const rowsByShard = new Map<number, { ws: number; from: number; count: number }[]>();
	let nextId = 1;
	for (let ws = 1; ws <= WORKSPACES; ws++) {
		const count = ws === BIG_WORKSPACE ? bigCount : perOther;
		const list = rowsByShard.get(shardIndexFor(ws)) ?? [];
		list.push({ ws, from: nextId, count });
		rowsByShard.set(shardIndexFor(ws), list);
		nextId += count;
	}
	for (const [index, list] of rowsByShard) {
		const shard = shardAt(index);
		for (const { ws, from, count } of list) {
			await shard.query(`INSERT INTO projects VALUES (${ws}, ${ws}, 'Project of workspace ${ws}')`);
			await shard.query(
				`INSERT INTO tasks SELECT g, ${ws}, ${ws},
				   CASE WHEN g % 3 = 0 THEN 'todo' ELSE 'done' END
				 FROM generate_series(${from}, ${from + count - 1}) g`
			);
		}
		await shard.query('ANALYZE tasks');
	}
}

const topRows = z.array(z.object({ workspaceId: z.coerce.number(), open: z.coerce.number() }));
type Top = z.infer<typeof topRows>[number];

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
	await fn(); // warm-up
	const started = performance.now();
	const value = await fn();
	return { value, ms: performance.now() - started };
}

async function main(): Promise<void> {
	await setup();

	console.log(
		`\n1. ${WORKSPACES} workspaces, ${TASKS.toLocaleString('en-US')} tasks — shard key: hash(workspaceId) % ${shards.length}`
	);
	const bigShard = shardIndexFor(BIG_WORKSPACE);
	for (const [i, shard] of shards.entries()) {
		const tasks = await scalar(shard, 'SELECT count(*) AS v FROM tasks');
		const workspaces = await scalar(shard, 'SELECT count(*) AS v FROM projects');
		const bar = '█'.repeat(Math.round((tasks / TASKS) * 40));
		console.log(
			`   shard${i}: ${String(workspaces).padStart(3)} workspaces  ${tasks.toLocaleString('en-US').padStart(8)} tasks  ${bar}${i === bigShard ? `  ← workspace ${BIG_WORKSPACE} (40%) is here` : ''}`
		);
	}

	console.log('\n2. A query with the shard key — "how many open tasks in workspace 42?"');
	const single = await timed(() =>
		scalar(
			shardFor(42),
			`SELECT count(*) AS v FROM tasks WHERE "workspaceId" = 42 AND status = 'todo'`
		)
	);
	console.log(
		`   → goes only to shard${shardIndexFor(42)}: ${single.value}, ${single.ms.toFixed(2)} ms`
	);

	console.log(
		'\n3. A query without the shard key — "which 10 workspaces have the most open tasks?"'
	);
	const sql = `SELECT "workspaceId", count(*) AS open FROM tasks WHERE status = 'todo'
	             GROUP BY "workspaceId" ORDER BY open DESC LIMIT 10`;
	const perShardMs: number[] = [];
	const gathered = await timed(async () => {
		perShardMs.length = 0;
		// Scatter: send to every shard at once; gather: merge in the app and sort again
		const parts = await Promise.all(
			shards.map(async (shard, i) => {
				const started = performance.now();
				const rows = topRows.parse(await shard.query(sql, { type: QueryTypes.SELECT }));
				perShardMs[i] = performance.now() - started;
				return rows;
			})
		);
		return parts
			.flat()
			.sort((a: Top, b: Top) => b.open - a.open)
			.slice(0, 10);
	});
	console.log(
		`   → sent to all ${shards.length} shards at once (scatter), merged and sorted in the app (gather): ${gathered.ms.toFixed(1)} ms total`
	);
	console.log(
		`     ${perShardMs.map((ms, i) => `shard${i}: ${ms.toFixed(1)} ms`).join(', ')} — the total equals the slowest one`
	);
	console.log(
		`     top 3: ${gathered.value
			.slice(0, 3)
			.map((r) => `workspace ${r.workspaceId} (${r.open})`)
			.join(', ')}`
	);

	console.log(
		'\n4. Work across two shards — moving a project to another workspace (on a different shard)'
	);
	const from =
		[...Array(WORKSPACES).keys()]
			.map((i) => i + 1)
			.find((ws) => ws !== BIG_WORKSPACE && shardIndexFor(ws) === 0) ?? 1;
	const to =
		[...Array(WORKSPACES).keys()].map((i) => i + 1).find((ws) => shardIndexFor(ws) === 2) ?? 2;
	console.log(`   project ${from}: workspace ${from} (shard0) → workspace ${to} (shard2)`);
	// step 1: write to the new shard (shard2's own transaction)
	await shardAt(2).transaction(async (transaction) => {
		await shardAt(2).query(
			`INSERT INTO projects VALUES (${from}, ${to}, 'Project of workspace ${from}')`,
			{ transaction }
		);
	});
	console.log('   step 1: project written to shard2 — COMMIT ✓');
	console.log('   step 2: the app crashed before deleting it from shard0 ✗');
	const inShard0 = await scalar(
		shardAt(0),
		`SELECT count(*) AS v FROM projects WHERE id = ${from}`
	);
	const inShard2 = await scalar(
		shardAt(2),
		`SELECT count(*) AS v FROM projects WHERE id = ${from}`
	);
	console.log(
		`   → project ${from} is now on shard0 (${inShard0}) and on shard2 (${inShard2}) — in both places! No single transaction could prevent it`
	);
	console.log('');
	await closeAll();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('shard failed:', error instanceof Error ? error.message : String(error));
	await closeAll();
	process.exit(1);
});
