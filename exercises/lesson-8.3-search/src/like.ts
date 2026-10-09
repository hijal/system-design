import type { Pool } from 'pg';
import { z } from 'zod';
import { commentText, DOMAIN, env, FILLER, pgPool, STOPWORDS } from './data';

// Lesson 8.3 §1.1–1.4 - four ways to search comments in Postgres, on the same 1,000,000 comments:
//   a. ILIKE '%…%' without an index        c. a pg_trgm GIN index (trigram)
//   b. a B-tree index (text_pattern_ops)    d. full-text search (tsvector + GIN), with ranking
// Then: the write cost of each index, and searching for misspellings ("did you mean").
// A real database, real time - the numbers will vary between machines. Every query runs three times; the middle one is shown.

const cfg = z
	.object({ WRITE_ROWS: z.coerce.number().int().positive().default(20_000) })
	.parse(process.env);

const fmt = (ms: number): string =>
	ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;

async function timed(
	pool: Pool,
	sql: string,
	params: unknown[] = []
): Promise<{ ms: number; rows: number }> {
	const times: number[] = [];
	let rows = 0;
	for (let i = 0; i < 3; i++) {
		const t = performance.now();
		const res = await pool.query(sql, params);
		times.push(performance.now() - t);
		const first: unknown = res.rows[0];
		// the number for count(*), otherwise how many rows came back
		const count = z.object({ n: z.coerce.number() }).safeParse(first);
		rows = count.success && res.rows.length === 1 ? count.data.n : res.rows.length;
	}
	times.sort((a, b) => a - b);
	return { ms: times[1] ?? 0, rows };
}

// EXPLAIN's first node and buffers (how many pages were read)
async function plan(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
	const res = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
	const node = z
		.object({
			'Node Type': z.string(),
			'Shared Hit Blocks': z.number(),
			'Shared Read Blocks': z.number(),
			Plans: z.array(z.object({ 'Node Type': z.string() }).passthrough()).optional()
		})
		.passthrough();
	const parsed = z.array(z.object({ Plan: node })).parse(res.rows[0]?.['QUERY PLAN']);
	const top = parsed[0]?.Plan;
	if (!top) return '?';
	// show the real searching node under the Aggregate/Limit
	const inner = top.Plans?.[0]?.['Node Type'];
	const pages = top['Shared Hit Blocks'] + top['Shared Read Blocks'];
	return `${inner ? `${top['Node Type']} ← ${inner}` : top['Node Type']} · ${pages.toLocaleString('en')} pages`;
}

async function size(pool: Pool, relation: string): Promise<string> {
	const res = await pool.query('SELECT pg_size_pretty(pg_relation_size($1::regclass)) AS s', [
		relation
	]);
	return String(res.rows[0]?.s);
}

async function timeIt(fn: () => Promise<unknown>): Promise<number> {
	const t = performance.now();
	await fn();
	return performance.now() - t;
}

const row = (label: string, r: { ms: number; rows: number }, extra = ''): void =>
	console.log(
		`   ${label.padEnd(44)} ${fmt(r.ms).padStart(10)} ${r.rows.toLocaleString('en').padStart(10)}   ${extra}`
	);

const QUERIES: ReadonlyArray<readonly [string, string]> = [
	['count all "deploy"', "SELECT count(*) AS n FROM comments WHERE body ILIKE '%deploy%'"],
	[
		'count all "rollback" (rare word)',
		"SELECT count(*) AS n FROM comments WHERE body ILIKE '%rollback%'"
	],
	[
		'first 20 "deploy" (common word)',
		"SELECT id FROM comments WHERE body ILIKE '%deploy%' LIMIT 20"
	],
	[
		'first 20 "rollback" (rare word)',
		"SELECT id FROM comments WHERE body ILIKE '%rollback%' LIMIT 20"
	],
	[
		'first 20 "recieve" (misspelled - none exist)',
		"SELECT id FROM comments WHERE body ILIKE '%recieve%' LIMIT 20"
	]
];

async function main(): Promise<void> {
	const pool = pgPool(4);
	const total = await pool.query('SELECT count(*)::int AS n FROM comments').catch(() => null);
	if (!total) {
		console.error(
			'the comments table is missing - run `docker compose up -d --wait` and `npm run seed` first.'
		);
		process.exit(1);
	}
	await pool.query(`
		CREATE EXTENSION IF NOT EXISTS pg_trgm;
		DROP INDEX IF EXISTS comments_lower_btree, comments_trgm, comments_fts;
		ALTER TABLE comments DROP COLUMN IF EXISTS tsv;`);
	// even when the previous run's tsv column is dropped its space stays in the table - VACUUM FULL rewrites the table,
	// so every run starts with a table of the same size. (VACUUM has to run on its own - not in a multi-statement query)
	await pool.query('VACUUM FULL ANALYZE comments');
	console.log(
		`\n   ${z.coerce.number().parse(total.rows[0]?.n).toLocaleString('en')} comments · table ${await size(pool, 'comments')}`
	);

	// ── A. without an index ─────────────────────────────────────
	console.log("\n── A. no index: ILIKE '%…%' ───────────────────────── time       found");
	for (const [label, sql] of QUERIES) row(label, await timed(pool, sql));
	console.log(`   plan, all "deploy" (in 28% of rows): ${await plan(pool, QUERIES[0]?.[1] ?? '')}`);
	console.log(`   plan, all "rollback" (rare):     ${await plan(pool, QUERIES[1]?.[1] ?? '')}`);

	// ── B. B-tree ───────────────────────────────────────────────
	const btreeMs = await timeIt(() =>
		pool.query('CREATE INDEX comments_lower_btree ON comments (lower(body) text_pattern_ops)')
	);
	await pool.query('ANALYZE comments');
	console.log(
		`\n── B. B-tree index, lower(body) text_pattern_ops (${fmt(btreeMs)} to build, ${await size(pool, 'comments_lower_btree')}) ──`
	);
	console.log(
		`   lower(body) LIKE '%deploy%' → ${await plan(pool, "SELECT count(*) FROM comments WHERE lower(body) LIKE '%deploy%'")}`
	);
	console.log(
		`   lower(body) LIKE 'deploy%'  → ${await plan(pool, "SELECT count(*) FROM comments WHERE lower(body) LIKE 'deploy%'")}   ← only "starts with deploy"`
	);
	await pool.query('DROP INDEX comments_lower_btree');

	// ── C. trigram ──────────────────────────────────────────────
	const trgmMs = await timeIt(() =>
		pool.query('CREATE INDEX comments_trgm ON comments USING gin (body gin_trgm_ops)')
	);
	await pool.query('ANALYZE comments');
	console.log(
		`\n── C. pg_trgm GIN index (${fmt(trgmMs)} to build, ${await size(pool, 'comments_trgm')}) ──── time       found`
	);
	for (const [label, sql] of QUERIES) row(label, await timed(pool, sql));
	console.log(`   plan, all "deploy" (in 28% of rows): ${await plan(pool, QUERIES[0]?.[1] ?? '')}`);
	console.log(`   plan, all "rollback" (rare):     ${await plan(pool, QUERIES[1]?.[1] ?? '')}`);
	const art = await timed(pool, "SELECT count(*) AS n FROM comments WHERE body ILIKE '%art%'");
	const log = await timed(pool, "SELECT count(*) AS n FROM comments WHERE body ILIKE '%log%'");
	await pool.query('DROP INDEX comments_trgm');

	// ── D. full-text search ─────────────────────────────────────
	const ftsMs = await timeIt(async () => {
		await pool.query(
			"ALTER TABLE comments ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED"
		);
		await pool.query('CREATE INDEX comments_fts ON comments USING gin (tsv)');
		await pool.query('VACUUM ANALYZE comments');
	});
	console.log(
		`\n── D. Full-text search: tsvector + GIN (${fmt(ftsMs)} to build column and index, index ${await size(pool, 'comments_fts')}, table now ${await size(pool, 'comments')}) ──`
	);
	const q = (tsquery: string): string =>
		`SELECT count(*) AS n FROM comments WHERE tsv @@ plainto_tsquery('english', '${tsquery}')`;
	row('count all "deploy"', await timed(pool, q('deploy')));
	row('"deploy checklist" (both present)', await timed(pool, q('deploy checklist')));
	row(
		'best 20 "deploy checklist" by ts_rank',
		await timed(
			pool,
			`
		SELECT id FROM comments, plainto_tsquery('english', 'deploy checklist') query
		WHERE tsv @@ query ORDER BY ts_rank(tsv, query) DESC LIMIT 20`
		)
	);
	row('"recieve" (misspelled)', await timed(pool, q('recieve')));
	console.log(`   plan (count all "deploy"): ${await plan(pool, q('deploy'))}`);
	const top = await pool.query(`
		SELECT id, body, round(ts_rank(tsv, query)::numeric, 3) AS rank
		FROM comments, plainto_tsquery('english', 'deploy checklist') query
		WHERE tsv @@ query ORDER BY ts_rank(tsv, query) DESC, id LIMIT 3`);
	console.log('   the 3 most relevant:');
	for (const r of top.rows) {
		const parsed = z.object({ id: z.number(), body: z.string(), rank: z.string() }).parse(r);
		console.log(
			`     #${parsed.id} (rank ${parsed.rank}) "${parsed.body.slice(0, 130)}${parsed.body.length > 130 ? '…' : ''}"`
		);
	}

	// ── words vs substrings ─────────────────────────────────────
	console.log('\n── Words vs substrings: what matches ──');
	const forms = await pool.query(`
		SELECT w, (SELECT count(*) FROM comments WHERE body ~* ('\\m' || w || '\\M'))::int AS n
		FROM unnest(ARRAY['deploy','deployment','deploying','redeploy']) AS w`);
	console.log(
		`   comments per form: ${forms.rows.map((r) => `${String(r.w)} ${String(r.n)}`).join(' · ')}`
	);
	const ilikeDeploy = await timed(
		pool,
		"SELECT count(*) AS n FROM comments WHERE body ILIKE '%deploy%'"
	);
	const ftsDeploy = await timed(pool, q('deploy'));
	const ftsRedeploy = await timed(pool, q('redeploy'));
	console.log(
		`   ILIKE '%deploy%': ${ilikeDeploy.rows.toLocaleString('en')} (including redeploy) · full-text "deploy": ${ftsDeploy.rows.toLocaleString('en')} (including deployment, deploying; redeploy excluded - a separate word, ${ftsRedeploy.rows.toLocaleString('en')} of them)`
	);
	const ftsArt = await timed(pool, q('art'));
	const ftsLog = await timed(pool, q('log'));
	console.log(
		`   ILIKE '%art%': ${art.rows.toLocaleString('en')} (start, party, article, smart …) · full-text "art": ${ftsArt.rows.toLocaleString('en')}`
	);
	console.log(
		`   ILIKE '%log%': ${log.rows.toLocaleString('en')} (login, blog, catalog) · full-text "log": ${ftsLog.rows.toLocaleString('en')}`
	);

	// ── write cost ──────────────────────────────────────────────
	console.log(
		`\n── Write cost: inserting ${cfg.WRITE_ROWS.toLocaleString('en')} new comments (1000 at a time) ──`
	);
	await pool.query(`
		DROP TABLE IF EXISTS w_plain, w_trgm, w_fts;
		CREATE TABLE w_plain (id int PRIMARY KEY, body text NOT NULL);
		CREATE TABLE w_trgm (id int PRIMARY KEY, body text NOT NULL);
		CREATE INDEX ON w_trgm USING gin (body gin_trgm_ops);
		CREATE TABLE w_fts (id int PRIMARY KEY, body text NOT NULL,
			tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED);
		CREATE INDEX ON w_fts USING gin (tsv);`);
	const texts = Array.from({ length: cfg.WRITE_ROWS }, (_, i) => commentText(env.ROWS + i + 1));
	const writeTimes: [string, number][] = [];
	for (const [label, table] of [
		['primary key only', 'w_plain'],
		['+ trigram GIN', 'w_trgm'],
		['+ full-text GIN', 'w_fts']
	] as const) {
		const ms = await timeIt(async () => {
			for (let start = 0; start < texts.length; start += 1000) {
				const chunk = texts.slice(start, start + 1000);
				const values = chunk.map((_, j) => `($${2 * j + 1}, $${2 * j + 2})`).join(',');
				await pool.query(
					`INSERT INTO ${table} (id, body) VALUES ${values}`,
					chunk.flatMap((b, j) => [start + j + 1, b])
				);
			}
		});
		writeTimes.push([label, ms]);
	}
	const base = writeTimes[0]?.[1] ?? 1;
	for (const [label, ms] of writeTimes)
		console.log(`   ${label.padEnd(20)} ${fmt(ms).padStart(10)}   ${(ms / base).toFixed(1)}×`);
	await pool.query('DROP TABLE w_plain, w_trgm, w_fts');

	// ── misspellings ────────────────────────────────────────────
	console.log('\n── Misspellings: trigram similarity against the word list ("did you mean") ──');
	await pool.query(`
		DROP TABLE IF EXISTS vocab;
		CREATE TABLE vocab (word text PRIMARY KEY);
		CREATE INDEX vocab_trgm ON vocab USING gin (word gin_trgm_ops);`);
	const words = [...new Set([...STOPWORDS, ...DOMAIN.map(([w]) => w), ...FILLER])];
	await pool.query('INSERT INTO vocab SELECT unnest($1::text[])', [words]);
	for (const typo of ['recieve', 'deplyo', 'chekclist']) {
		const res = await pool.query(
			`SELECT word, round(similarity(word, $1)::numeric, 2) AS s FROM vocab
			 WHERE word % $1 ORDER BY similarity(word, $1) DESC, word LIMIT 3`,
			[typo]
		);
		const list = res.rows.map((r) => `${String(r.word)} (${String(r.s)})`).join(', ');
		console.log(`   "${typo}" → ${list || '(nothing)'}`);
	}
	console.log();
	await pool.end();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
