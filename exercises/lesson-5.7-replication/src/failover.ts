import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { z } from 'zod';
import { primary, replica, scalarText, sleep, waitForCatchUp } from './db';

// Lesson 5.7 §১.৫ — failover, আর async replication এ ঠিক কোন data হারায়।
//
//   ১. সব ঠিক আছে: ১০টা event লেখা, replica তে পৌঁছেছে
//   ২. Network সমস্যা: replica primary থেকে বিচ্ছিন্ন
//   ৩. Primary তে আরও ২০টা async event — user কে "saved" বলা হয়েছে
//   ৪. একটা sync (remote_apply) event — commit আটকে থাকে
//   ৫. Primary মারা যায়
//   ৬. Replica কে promote করা হয় — এখন সে নতুন primary
//   ৭. গুনে দেখা: কোন event গুলো আছে?
//
// ⚠️ এটা চালানোর পরে cluster ভাঙা অবস্থায় থাকে (primary মৃত, replica promoted)।
//    আবার শুরু করতে: docker compose down -v && docker compose up -d --wait

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

	step('১.', 'স্বাভাবিক অবস্থা — ১০টা event, replica তে পৌঁছানো পর্যন্ত অপেক্ষা');
	await primary.query('DROP TABLE IF EXISTS events');
	await primary.query('CREATE TABLE events (id serial PRIMARY KEY, kind text NOT NULL)');
	await primary.query(`INSERT INTO events (kind) SELECT 'before' FROM generate_series(1, 10)`);
	await waitForCatchUp();
	console.log('      ✓ replica ধরে ফেলেছে');

	step('২.', 'Network সমস্যা — replica কে primary থেকে বিচ্ছিন্ন করা');
	docker('network', 'disconnect', network, replicaId);

	step('৩.', 'Primary তে ২০টা event (async) — প্রতিটা commit সফল, user দেখছে "saved"');
	for (let i = 0; i < 20; i++) await primary.query(`INSERT INTO events (kind) VALUES ('async')`);
	console.log('      ✓ ২০টা commit সফল');

	step('৪.', 'একটা event synchronous_commit = remote_apply দিয়ে');
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
		`      ৩ সেকেন্ড পরে: commit এখনো replica এর অপেক্ষায় আটকে আছে? ${waiting === '1' ? 'হ্যাঁ' : 'না'}`
	);
	console.log('      → app এর timeout এ ধৈর্য শেষ; query টা cancel করা হলো');
	await primary.query(
		`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE wait_event = 'SyncRep'`
	);
	await syncWrite;
	await client.end();
	console.log(
		`      COMMIT ফেরত এলো ${((Date.now() - started) / 1000).toFixed(1)}s পরে, সাথে Postgres এর সতর্কবার্তা:`
	);
	for (const notice of notices) console.log(`        WARNING: ${notice}`);

	step('৫.', 'Primary মারা গেল (docker kill)');
	docker('compose', 'kill', 'primary');
	try {
		await primary.query(`INSERT INTO events (kind) VALUES ('after-crash')`);
	} catch (error: unknown) {
		console.log(
			`      app এর নতুন write: ✗ ${error instanceof Error ? error.message : String(error)}`
		);
	}

	step('৬.', 'Failover — replica কে promote করা (pg_promote)');
	docker('network', 'connect', '--alias', 'replica', network, replicaId);
	await replica.query('SELECT pg_promote()');
	const inRecovery = await scalarText(replica, 'SELECT pg_is_in_recovery()::text AS v');
	console.log(
		`      replica এখনো read-only standby? ${inRecovery === 'true' ? 'হ্যাঁ' : 'না — এখন সে নতুন primary, write নেয়'}`
	);
	await replica.query(`INSERT INTO events (kind) VALUES ('after-failover')`);
	console.log('      ✓ নতুন primary তে write সফল (app কে এখন নতুন ঠিকানায় পাঠাতে হবে)');

	step('৭.', 'নতুন primary তে কী আছে?');
	const rows = countRows.parse(
		await replica.query('SELECT kind, count(*) AS n FROM events GROUP BY kind ORDER BY min(id)', {
			type: 'SELECT'
		})
	);
	const have = new Map(rows.map((r) => [r.kind, r.n]));
	const report: [string, number, string][] = [
		['before', 10, ''],
		['async', 20, 'হারিয়ে গেছে — অথচ user কে "saved" বলা হয়েছিল'],
		['sync', 1, 'হারিয়ে গেছে — app timeout পেয়েছিল, কিন্তু পুরনো primary তে এটা commit হয়ে ছিল'],
		['after-failover', 1, '']
	];
	for (const [kind, expected, lostNote] of report) {
		const n = have.get(kind) ?? 0;
		console.log(
			`      ${kind.padEnd(16)} ${String(n).padStart(3)}/${expected}  ${n === expected ? '✓' : `✗ ${lostNote}`}`
		);
	}

	console.log('\n   ⚠️  cluster এখন ভাঙা অবস্থায়। আবার শুরু করতে:');
	console.log('      docker compose down -v && docker compose up -d --wait\n');
	await Promise.allSettled([primary.close(), replica.close()]);
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('failover failed:', error instanceof Error ? error.message : String(error));
	await Promise.allSettled([primary.close(), replica.close()]);
	process.exit(1);
});
