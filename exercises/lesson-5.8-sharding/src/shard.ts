import { performance } from 'node:perf_hooks';
import { QueryTypes, type Sequelize } from 'sequelize';
import { z } from 'zod';
import { closeAll, scalar, shardAt, shards } from './db';
import { moduloShard } from './hash';

// Lesson 5.8 §১.৩–১.৬ — TaskFlow কে ৩টা database এ ভাগ করা, shard key = workspaceId।
// একটা workspace এর সব data একটা shard এ — তাই workspace এর ভেতরের সব কাজ এক জায়গায়।

const WORKSPACES = 300;
const TASKS = 300_000;
const BIG_WORKSPACE = 7; // একটা বিশাল enterprise customer — সব task এর ৪০%
const BIG_SHARE = 0.4;

function shardFor(workspaceId: number): Sequelize {
	return shardAt(moduloShard(`ws:${workspaceId}`, shards.length));
}

function shardIndexFor(workspaceId: number): number {
	return moduloShard(`ws:${workspaceId}`, shards.length);
}

async function setup(): Promise<void> {
	// প্রতিটা shard এ একই schema
	for (const shard of shards) {
		await shard.query('DROP TABLE IF EXISTS tasks, projects');
		await shard.query(`CREATE TABLE projects (
			id integer PRIMARY KEY, "workspaceId" integer NOT NULL, name text NOT NULL)`);
		await shard.query(`CREATE TABLE tasks (
			id bigint PRIMARY KEY, "workspaceId" integer NOT NULL, "projectId" integer NOT NULL,
			status text NOT NULL)`);
		await shard.query('CREATE INDEX ON tasks ("workspaceId", status)');
	}

	// প্রতিটা workspace এ একটা project; task গুলো workspace এ ভাগ — ৪০% একটায়
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
		`\n১. ${WORKSPACES}টা workspace, ${TASKS.toLocaleString('en-US')}টা task — shard key: hash(workspaceId) % ${shards.length}`
	);
	const bigShard = shardIndexFor(BIG_WORKSPACE);
	for (const [i, shard] of shards.entries()) {
		const tasks = await scalar(shard, 'SELECT count(*) AS v FROM tasks');
		const workspaces = await scalar(shard, 'SELECT count(*) AS v FROM projects');
		const bar = '█'.repeat(Math.round((tasks / TASKS) * 40));
		console.log(
			`   shard${i}: ${String(workspaces).padStart(3)}টা workspace  ${tasks.toLocaleString('en-US').padStart(8)}টা task  ${bar}${i === bigShard ? `  ← workspace ${BIG_WORKSPACE} (৪০%) এখানে` : ''}`
		);
	}

	console.log('\n২. Shard key সহ query — "workspace 42 এ কয়টা খোলা task?"');
	const single = await timed(() =>
		scalar(
			shardFor(42),
			`SELECT count(*) AS v FROM tasks WHERE "workspaceId" = 42 AND status = 'todo'`
		)
	);
	console.log(
		`   → শুধু shard${shardIndexFor(42)} এ যায়: ${single.value}টা, ${single.ms.toFixed(2)} ms`
	);

	console.log('\n৩. Shard key ছাড়া query — "সবচেয়ে বেশি খোলা task কোন ১০টা workspace এ?"');
	const sql = `SELECT "workspaceId", count(*) AS open FROM tasks WHERE status = 'todo'
	             GROUP BY "workspaceId" ORDER BY open DESC LIMIT 10`;
	const perShardMs: number[] = [];
	const gathered = await timed(async () => {
		perShardMs.length = 0;
		// Scatter: সব shard এ একসাথে পাঠাও; gather: app এ মিলিয়ে আবার সাজাও
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
		`   → ${shards.length}টা shard এ একসাথে (scatter), app এ মিলিয়ে সাজানো (gather): মোট ${gathered.ms.toFixed(1)} ms`
	);
	console.log(
		`     ${perShardMs.map((ms, i) => `shard${i}: ${ms.toFixed(1)} ms`).join(', ')} — মোট সময় সবচেয়ে ধীরটার সমান`
	);
	console.log(
		`     শীর্ষ ৩: ${gathered.value
			.slice(0, 3)
			.map((r) => `workspace ${r.workspaceId} (${r.open})`)
			.join(', ')}`
	);

	console.log('\n৪. দুই shard জুড়ে কাজ — project কে অন্য workspace এ সরানো (আলাদা shard এ)');
	const from =
		[...Array(WORKSPACES).keys()]
			.map((i) => i + 1)
			.find((ws) => ws !== BIG_WORKSPACE && shardIndexFor(ws) === 0) ?? 1;
	const to =
		[...Array(WORKSPACES).keys()].map((i) => i + 1).find((ws) => shardIndexFor(ws) === 2) ?? 2;
	console.log(`   project ${from}: workspace ${from} (shard0) → workspace ${to} (shard2)`);
	// ধাপ ১: নতুন shard এ লেখো (shard2 এর নিজের transaction)
	await shardAt(2).transaction(async (transaction) => {
		await shardAt(2).query(
			`INSERT INTO projects VALUES (${from}, ${to}, 'Project of workspace ${from}')`,
			{ transaction }
		);
	});
	console.log('   ধাপ ১: shard2 তে project লেখা হলো — COMMIT ✓');
	console.log('   ধাপ ২: shard0 থেকে মুছে ফেলার আগেই app crash করল ✗');
	const inShard0 = await scalar(
		shardAt(0),
		`SELECT count(*) AS v FROM projects WHERE id = ${from}`
	);
	const inShard2 = await scalar(
		shardAt(2),
		`SELECT count(*) AS v FROM projects WHERE id = ${from}`
	);
	console.log(
		`   → project ${from} এখন shard0 এ ${inShard0}টা, shard2 এ ${inShard2}টা — দুই জায়গাতেই! কোনো একক transaction এটা আটকাতে পারেনি`
	);
	console.log('');
	await closeAll();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('shard failed:', error instanceof Error ? error.message : String(error));
	await closeAll();
	process.exit(1);
});
