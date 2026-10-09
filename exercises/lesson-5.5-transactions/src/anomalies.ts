import { QueryTypes, Transaction } from 'sequelize';
import { z } from 'zod';
import { Member, Project, Task, sequelize, sleep } from './db';
import { pgErrorCode } from './retry';

// Lesson 5.5 - running the steps of two transactions (A and B) **in a fixed order** to see each
// anomaly with your own eyes. No reliance on a race - the interleaving is arranged by hand, so the result
// is the same every time. Each transaction has its own connection (a Sequelize unmanaged transaction).

const { READ_UNCOMMITTED, READ_COMMITTED, REPEATABLE_READ, SERIALIZABLE } =
	Transaction.ISOLATION_LEVELS;
type Level = Transaction.ISOLATION_LEVELS;

const intRow = z.array(z.object({ v: z.coerce.number() })).length(1);
const textRow = z.array(z.object({ v: z.string() })).length(1);

async function readInt(sql: string, t: Transaction): Promise<number> {
	const rows = intRow.parse(
		await sequelize.query(sql, { transaction: t, type: QueryTypes.SELECT })
	);
	return rows[0]?.v ?? Number.NaN;
}

async function readText(sql: string, t: Transaction): Promise<string> {
	const rows = textRow.parse(
		await sequelize.query(sql, { transaction: t, type: QueryTypes.SELECT })
	);
	return rows[0]?.v ?? '?';
}

async function exec(sql: string, t: Transaction): Promise<void> {
	await sequelize.query(sql, { transaction: t });
}

function begin(level: Level): Promise<Transaction> {
	return sequelize.transaction({ isolationLevel: level });
}

const short: Record<Level, string> = {
	[READ_UNCOMMITTED]: 'READ UNCOMMITTED',
	[READ_COMMITTED]: 'READ COMMITTED',
	[REPEATABLE_READ]: 'REPEATABLE READ',
	[SERIALIZABLE]: 'SERIALIZABLE'
};

function log(who: 'A' | 'B' | '→', text: string): void {
	console.log(`     ${who === '→' ? '  →' : `${who}:`} ${text}`);
}

function heading(text: string): void {
	console.log(`\n━━ ${text} ${'━'.repeat(Math.max(0, 66 - text.length))}`);
}

// pull Postgres's error code out of a failed transaction and describe it in one line
function describeFailure(error: unknown): string {
	const code = pgErrorCode(error);
	if (code === '40001') return 'ERROR 40001 - could not serialize access (serialization failure)';
	return `ERROR ${code ?? '?'} - ${error instanceof Error ? error.message : String(error)}`;
}

async function reset(): Promise<void> {
	await sequelize.sync({ force: true });
	await Project.create({ name: 'Website', openTaskCount: 5 });
	await Task.bulkCreate([
		{ projectId: 1, title: 'Login bug' },
		{ projectId: 1, title: 'Signup page' },
		{ projectId: 1, title: 'Footer' }
	]);
	await Member.bulkCreate([
		{ projectId: 1, name: 'Rahim', role: 'admin' },
		{ projectId: 1, name: 'Karim', role: 'admin' },
		{ projectId: 1, name: 'Nadia', role: 'member' }
	]);
}

// ── 1. Lost update ──────────────────────────────────────────────────────────
// both read the counter, +1 in JS, and write it back (Lesson 5.2's naive strategy).
async function lostUpdate(level: Level): Promise<void> {
	await reset();
	console.log(`\n   [${short[level]}]  openTaskCount starts at 5; both are adding one task`);
	const a = await begin(level);
	const b = await begin(level);
	const readSql = 'SELECT "openTaskCount" AS v FROM projects WHERE id = 1';

	const aSaw = await readInt(readSql, a);
	log('A', `read ${aSaw}`);
	const bSaw = await readInt(readSql, b);
	log('B', `read ${bSaw}`);
	await exec(`UPDATE projects SET "openTaskCount" = ${aSaw + 1} WHERE id = 1`, a);
	log('A', `wrote ${aSaw + 1}, COMMIT`);
	await a.commit();
	let bFailed = false;
	try {
		await exec(`UPDATE projects SET "openTaskCount" = ${bSaw + 1} WHERE id = 1`, b);
		await b.commit();
		log('B', `wrote ${bSaw + 1}, COMMIT`);
	} catch (error: unknown) {
		bFailed = true;
		await b.rollback();
		log('B', `tried to write → ${describeFailure(error)}, ROLLBACK`);
	}
	const final = (await Project.findByPk(1))?.openTaskCount;
	const verdict = bFailed
		? " - B's work didn't happen, but B knows it; a retry gives 7. Not silently lost"
		: final === 6
			? ' - one update silently lost, nobody got an error'
			: '';
	log('→', `final value ${final} (should be 7)${verdict}`);
}

// ── 1b. SELECT ... FOR UPDATE - pessimistic lock ────────────────────────────
async function lostUpdateForUpdate(): Promise<void> {
	await reset();
	console.log('\n   [READ COMMITTED + SELECT ... FOR UPDATE]');
	const a = await begin(READ_COMMITTED);
	const b = await begin(READ_COMMITTED);
	const lockSql = 'SELECT "openTaskCount" AS v FROM projects WHERE id = 1 FOR UPDATE';

	const aSaw = await readInt(lockSql, a);
	log('A', `read ${aSaw} (took the row lock)`);

	let bDone = false;
	const bRead = readInt(lockSql, b).then((v) => {
		bDone = true;
		return v;
	});
	await sleep(300);
	log(
		'B',
		`wanted to read the same row FOR UPDATE… still waiting after 300 ms? ${bDone ? 'no' : 'yes'}`
	);

	await exec(`UPDATE projects SET "openTaskCount" = ${aSaw + 1} WHERE id = 1`, a);
	await a.commit();
	log('A', `wrote ${aSaw + 1}, COMMIT → released the lock`);

	const bSaw = await bRead;
	log('B', `could read now: ${bSaw} (the value A committed)`);
	await exec(`UPDATE projects SET "openTaskCount" = ${bSaw + 1} WHERE id = 1`, b);
	await b.commit();
	log('B', `wrote ${bSaw + 1}, COMMIT`);
	log('→', `final value ${(await Project.findByPk(1))?.openTaskCount} (should be 7)`);
}

// ── 2. Non-repeatable read ──────────────────────────────────────────────────
async function nonRepeatableRead(level: Level): Promise<void> {
	await reset();
	console.log(`\n   [${short[level]}]  A reads the same row twice, B changes the name in between`);
	const a = await begin(level);
	const sql = 'SELECT name AS v FROM projects WHERE id = 1';
	log('A', `first read: "${await readText(sql, a)}"`);
	const b = await begin(level);
	await exec(`UPDATE projects SET name = 'Website v2' WHERE id = 1`, b);
	await b.commit();
	log('B', `renamed to "Website v2", COMMIT`);
	log('A', `second read: "${await readText(sql, a)}"`);
	await a.commit();
}

// ── 3. Phantom read ─────────────────────────────────────────────────────────
async function phantomRead(level: Level): Promise<void> {
	await reset();
	console.log(
		`\n   [${short[level]}]  A counts the rows matching a condition twice, B adds a new row in between`
	);
	const a = await begin(level);
	const sql = 'SELECT count(*) AS v FROM tasks WHERE "projectId" = 1';
	log('A', `first count: ${await readInt(sql, a)} tasks`);
	const b = await begin(level);
	await exec(`INSERT INTO tasks ("projectId", title) VALUES (1, 'New task')`, b);
	await b.commit();
	log('B', 'added a new task, COMMIT');
	log('A', `second count: ${await readInt(sql, a)} tasks`);
	await a.commit();
}

// ── 4. Write skew ───────────────────────────────────────────────────────────
// The rule: "every project must have at least one admin."
// Rahim and Karim remove themselves as admin at the same moment. Both check first.
async function writeSkew(level: Level): Promise<void> {
	await reset();
	console.log(
		`\n   [${short[level]}]  rule: there must always be at least 1 admin. Rahim and Karim remove themselves at once`
	);
	const a = await begin(level);
	const b = await begin(level);
	const countSql = `SELECT count(*) AS v FROM members WHERE "projectId" = 1 AND role = 'admin'`;

	const aCount = await readInt(countSql, a);
	log('A', `Rahim checked: ${aCount} admins → "one will remain if I leave" ✓`);
	const bCount = await readInt(countSql, b);
	log('B', `Karim checked: ${bCount} admins → "one will remain if I leave" ✓`);

	await exec(`UPDATE members SET role = 'member' WHERE name = 'Rahim'`, a);
	await exec(`UPDATE members SET role = 'member' WHERE name = 'Karim'`, b);
	log('A', 'Rahim made himself a member');
	log('B', 'Karim made himself a member');

	for (const [who, t] of [
		['A', a],
		['B', b]
	] as const) {
		try {
			await t.commit();
			log(who, 'COMMIT ✓');
		} catch (error: unknown) {
			log(who, `COMMIT → ${describeFailure(error)}`);
		}
	}
	const admins = await Member.count({ where: { projectId: 1, role: 'admin' } });
	log(
		'→',
		`admins now: ${admins}${admins === 0 ? ' - the rule is broken, even though both checked it!' : ' - the rule holds'}`
	);
}

// ── 5. Dirty read - Postgres never allows it ────────────────────────────────
async function dirtyRead(): Promise<void> {
	await reset();
	console.log('\n   [B = READ UNCOMMITTED]  A renamed it but did not COMMIT');
	const a = await begin(READ_COMMITTED);
	await exec(`UPDATE projects SET name = 'Draft name' WHERE id = 1`, a);
	log('A', `renamed to "Draft name" - not committed yet`);
	const b = await begin(READ_UNCOMMITTED);
	log('B', `read: "${await readText('SELECT name AS v FROM projects WHERE id = 1', b)}"`);
	await b.commit();
	await a.rollback();
	log('A', 'ROLLBACK - "Draft name" was never true');
	log('→', 'in Postgres READ UNCOMMITTED actually behaves like READ COMMITTED');
}

async function main(): Promise<void> {
	heading('1. Lost update - read-modify-write');
	await lostUpdate(READ_COMMITTED);
	await lostUpdate(REPEATABLE_READ);
	await lostUpdateForUpdate();

	heading('2. Non-repeatable read');
	await nonRepeatableRead(READ_COMMITTED);
	await nonRepeatableRead(REPEATABLE_READ);

	heading('3. Phantom read');
	await phantomRead(READ_COMMITTED);
	await phantomRead(REPEATABLE_READ);

	heading('4. Write skew');
	await writeSkew(REPEATABLE_READ);
	await writeSkew(SERIALIZABLE);

	heading('5. Dirty read');
	await dirtyRead();

	console.log('');
	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('anomalies failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
