import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { z } from 'zod';
import { primary, replica, scalarText, sleep, waitForCatchUp } from './db';

// Lesson 5.7 §1.5 — failover, and exactly which data is lost with async replication.
//
//   1. all is well: 10 events written, they reached the replica
//   2. a network problem: the replica is cut off from the primary
//   3. 20 more async events on the primary — the user was told "saved"
//   4. one sync (remote_apply) event — the commit is stuck
//   5. the primary dies
//   6. the replica is promoted — now it is the new primary
//   7. counting: which events are there?
//
// ⚠️ After running this the cluster is left broken (the primary dead, the replica promoted).
//    To start again: docker compose down -v && docker compose up -d --wait

const PRIMARY_URL = 'postgres://taskflow:taskflow@localhost:5438/taskflow';

function docker(...args: string[]): string {
	return execFileSync('docker', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	}).trim();
}

function step(n: string, text: string): void {
	console.log(`\n   ${n} ${text}`);
}

const countRows = z.array(z.object({ kind: z.string(), n: z.coerce.number() }));

async function main(): Promise<void> {
	const replicaId = docker('compose', 'ps', '-q', 'replica');
	const network = docker(
		'inspect',
		'-f',
		'{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}',
		replicaId
	);

	step('1.', 'normal state — 10 events, waiting until they reach the replica');
	await primary.query('DROP TABLE IF EXISTS events');
	await primary.query('CREATE TABLE events (id serial PRIMARY KEY, kind text NOT NULL)');
	await primary.query(`INSERT INTO events (kind) SELECT 'before' FROM generate_series(1, 10)`);
	await waitForCatchUp();
	console.log('      ✓ the replica caught up');

	step('2.', 'Network problem — cutting the replica off from the primary');
	docker('network', 'disconnect', network, replicaId);

	step('3.', '20 events (async) on the primary — every commit succeeds, the user sees "saved"');
	for (let i = 0; i < 20; i++) await primary.query(`INSERT INTO events (kind) VALUES ('async')`);
	console.log('      ✓ 20 commits succeeded');

	step('4.', 'one event with synchronous_commit = remote_apply');
	const client = new Client({ connectionString: PRIMARY_URL });
	const notices: string[] = [];
	client.on('notice', (msg) =>
		notices.push(`${msg.message}${msg.detail ? ` — ${msg.detail}` : ''}`)
	);
	await client.connect();
	const started = Date.now();
	const syncWrite = client.query(
		`BEGIN; SET LOCAL synchronous_commit = remote_apply; INSERT INTO events (kind) VALUES ('sync'); COMMIT;`
	);
	await sleep(3_000);
	const waiting = await scalarText(
		primary,
		`SELECT count(*)::text AS v FROM pg_stat_activity WHERE wait_event = 'SyncRep'`
	);
	console.log(
		`      after 3 seconds: is the commit still stuck waiting for the replica? ${waiting === '1' ? 'yes' : 'no'}`
	);
	console.log("      → the app's timeout ran out of patience; the query was cancelled");
	await primary.query(
		`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE wait_event = 'SyncRep'`
	);
	await syncWrite;
	await client.end();
	console.log(
		`      COMMIT came back after ${((Date.now() - started) / 1000).toFixed(1)}s, with a warning from Postgres:`
	);
	for (const notice of notices) console.log(`        WARNING: ${notice}`);

	step('5.', 'The primary died (docker kill)');
	docker('compose', 'kill', 'primary');
	try {
		await primary.query(`INSERT INTO events (kind) VALUES ('after-crash')`);
	} catch (error: unknown) {
		console.log(
			`      a new write from the app: ✗ ${error instanceof Error ? error.message : String(error)}`
		);
	}

	step('6.', 'Failover — promoting the replica (pg_promote)');
	docker('network', 'connect', '--alias', 'replica', network, replicaId);
	await replica.query('SELECT pg_promote()');
	const inRecovery = await scalarText(replica, 'SELECT pg_is_in_recovery()::text AS v');
	console.log(
		`      is the replica still a read-only standby? ${inRecovery === 'true' ? 'yes' : 'no — it is the new primary now, it takes writes'}`
	);
	await replica.query(`INSERT INTO events (kind) VALUES ('after-failover')`);
	console.log(
		'      ✓ write on the new primary succeeded (the app now has to be sent to the new address)'
	);

	step('7.', 'What is on the new primary?');
	const rows = countRows.parse(
		await replica.query('SELECT kind, count(*) AS n FROM events GROUP BY kind ORDER BY min(id)', {
			type: 'SELECT'
		})
	);
	const have = new Map(rows.map((r) => [r.kind, r.n]));
	const report: [string, number, string][] = [
		['before', 10, ''],
		['async', 20, 'lost — even though the user was told "saved"'],
		['sync', 1, 'lost — the app got a timeout, but it had been committed on the old primary'],
		['after-failover', 1, '']
	];
	for (const [kind, expected, lostNote] of report) {
		const n = have.get(kind) ?? 0;
		console.log(
			`      ${kind.padEnd(16)} ${String(n).padStart(3)}/${expected}  ${n === expected ? '✓' : `✗ ${lostNote}`}`
		);
	}

	console.log('\n   ⚠️  the cluster is broken now. To start again:');
	console.log('      docker compose down -v && docker compose up -d --wait\n');
	await Promise.allSettled([primary.close(), replica.close()]);
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('failover failed:', error instanceof Error ? error.message : String(error));
	await Promise.allSettled([primary.close(), replica.close()]);
	process.exit(1);
});
