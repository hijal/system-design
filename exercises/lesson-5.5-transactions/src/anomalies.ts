import { QueryTypes, Transaction } from 'sequelize';
import { z } from 'zod';
import { Member, Project, Task, sequelize, sleep } from './db';
import { pgErrorCode } from './retry';

// Lesson 5.5 — দুটো transaction (A আর B) এর ধাপগুলো **নির্দিষ্ট ক্রমে** চালিয়ে প্রতিটা
// anomaly চোখে দেখা। Race এর উপর ভরসা না — interleaving টা হাতে সাজানো, তাই প্রতিবার
// একই ফল। প্রতিটা transaction এর নিজের connection (Sequelize unmanaged transaction)।

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

// ব্যর্থ transaction থেকে Postgres এর error code বের করে এক লাইনে বলা
function describeFailure(error: unknown): string {
	const code = pgErrorCode(error);
	if (code === '40001') return 'ERROR 40001 — could not serialize access (serialization failure)';
	return `ERROR ${code ?? '?'} — ${error instanceof Error ? error.message : String(error)}`;
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

// ── ১. Lost update ───────────────────────────────────────────────────────────
// দুজনেই counter পড়ে, JS এ +1 করে, লিখে দেয় (Lesson 5.2 এর naive কৌশল)।
async function lostUpdate(level: Level): Promise<void> {
	await reset();
	console.log(`\n   [${short[level]}]  openTaskCount শুরুতে 5; দুজনেই একটা করে task যোগ করছে`);
	const a = await begin(level);
	const b = await begin(level);
	const readSql = 'SELECT "openTaskCount" AS v FROM projects WHERE id = 1';

	const aSaw = await readInt(readSql, a);
	log('A', `পড়ল ${aSaw}`);
	const bSaw = await readInt(readSql, b);
	log('B', `পড়ল ${bSaw}`);
	await exec(`UPDATE projects SET "openTaskCount" = ${aSaw + 1} WHERE id = 1`, a);
	log('A', `লিখল ${aSaw + 1}, COMMIT`);
	await a.commit();
	let bFailed = false;
	try {
		await exec(`UPDATE projects SET "openTaskCount" = ${bSaw + 1} WHERE id = 1`, b);
		await b.commit();
		log('B', `লিখল ${bSaw + 1}, COMMIT`);
	} catch (error: unknown) {
		bFailed = true;
		await b.rollback();
		log('B', `লিখতে গেল → ${describeFailure(error)}, ROLLBACK`);
	}
	const final = (await Project.findByPk(1))?.openTaskCount;
	const verdict = bFailed
		? ' — B এর কাজ হয়নি, কিন্তু B সেটা জানে; retry করলে 7 হবে। নীরবে হারায়নি'
		: final === 6
			? ' — একটা update নীরবে হারিয়ে গেছে, কেউ কোনো error পায়নি'
			: '';
	log('→', `শেষ মান ${final} (হওয়া উচিত 7)${verdict}`);
}

// ── ১খ. SELECT ... FOR UPDATE — pessimistic lock ─────────────────────────────
async function lostUpdateForUpdate(): Promise<void> {
	await reset();
	console.log('\n   [READ COMMITTED + SELECT ... FOR UPDATE]');
	const a = await begin(READ_COMMITTED);
	const b = await begin(READ_COMMITTED);
	const lockSql = 'SELECT "openTaskCount" AS v FROM projects WHERE id = 1 FOR UPDATE';

	const aSaw = await readInt(lockSql, a);
	log('A', `পড়ল ${aSaw} (row lock নিল)`);

	let bDone = false;
	const bRead = readInt(lockSql, b).then((v) => {
		bDone = true;
		return v;
	});
	await sleep(300);
	log('B', `একই row FOR UPDATE পড়তে চাইল… ৩০০ ms পরেও অপেক্ষায়? ${bDone ? 'না' : 'হ্যাঁ'}`);

	await exec(`UPDATE projects SET "openTaskCount" = ${aSaw + 1} WHERE id = 1`, a);
	await a.commit();
	log('A', `লিখল ${aSaw + 1}, COMMIT → lock ছাড়ল`);

	const bSaw = await bRead;
	log('B', `এবার পড়তে পারল: ${bSaw} (A এর commit করা মান)`);
	await exec(`UPDATE projects SET "openTaskCount" = ${bSaw + 1} WHERE id = 1`, b);
	await b.commit();
	log('B', `লিখল ${bSaw + 1}, COMMIT`);
	log('→', `শেষ মান ${(await Project.findByPk(1))?.openTaskCount} (হওয়া উচিত 7)`);
}

// ── ২. Non-repeatable read ───────────────────────────────────────────────────
async function nonRepeatableRead(level: Level): Promise<void> {
	await reset();
	console.log(`\n   [${short[level]}]  A একই row দুবার পড়ছে, মাঝখানে B নাম বদলাল`);
	const a = await begin(level);
	const sql = 'SELECT name AS v FROM projects WHERE id = 1';
	log('A', `প্রথমবার পড়ল: "${await readText(sql, a)}"`);
	const b = await begin(level);
	await exec(`UPDATE projects SET name = 'Website v2' WHERE id = 1`, b);
	await b.commit();
	log('B', `নাম বদলে "Website v2", COMMIT`);
	log('A', `দ্বিতীয়বার পড়ল: "${await readText(sql, a)}"`);
	await a.commit();
}

// ── ৩. Phantom read ──────────────────────────────────────────────────────────
async function phantomRead(level: Level): Promise<void> {
	await reset();
	console.log(`\n   [${short[level]}]  A একটা শর্তে row গুনছে দুবার, মাঝখানে B নতুন row যোগ করল`);
	const a = await begin(level);
	const sql = 'SELECT count(*) AS v FROM tasks WHERE "projectId" = 1';
	log('A', `প্রথমবার গুনল: ${await readInt(sql, a)}টা task`);
	const b = await begin(level);
	await exec(`INSERT INTO tasks ("projectId", title) VALUES (1, 'New task')`, b);
	await b.commit();
	log('B', 'নতুন task যোগ করল, COMMIT');
	log('A', `দ্বিতীয়বার গুনল: ${await readInt(sql, a)}টা task`);
	await a.commit();
}

// ── ৪. Write skew ────────────────────────────────────────────────────────────
// নিয়ম: "প্রতিটা project এ অন্তত একজন admin থাকতেই হবে।"
// Rahim আর Karim একই মুহূর্তে নিজেকে admin থেকে সরাচ্ছে। দুজনেই আগে যাচাই করে।
async function writeSkew(level: Level): Promise<void> {
	await reset();
	console.log(
		`\n   [${short[level]}]  নিয়ম: অন্তত ১ জন admin থাকবেই। Rahim আর Karim একসাথে নিজেকে সরাচ্ছে`
	);
	const a = await begin(level);
	const b = await begin(level);
	const countSql = `SELECT count(*) AS v FROM members WHERE "projectId" = 1 AND role = 'admin'`;

	const aCount = await readInt(countSql, a);
	log('A', `Rahim যাচাই করল: admin ${aCount} জন → "আমি সরলেও একজন থাকবে" ✓`);
	const bCount = await readInt(countSql, b);
	log('B', `Karim যাচাই করল: admin ${bCount} জন → "আমি সরলেও একজন থাকবে" ✓`);

	await exec(`UPDATE members SET role = 'member' WHERE name = 'Rahim'`, a);
	await exec(`UPDATE members SET role = 'member' WHERE name = 'Karim'`, b);
	log('A', 'Rahim নিজেকে member করল');
	log('B', 'Karim নিজেকে member করল');

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
		`এখন admin: ${admins} জন${admins === 0 ? ' — নিয়ম ভেঙে গেছে, অথচ দুজনেই নিয়ম যাচাই করেছিল!' : ' — নিয়ম টিকে আছে'}`
	);
}

// ── ৫. Dirty read — Postgres কখনো হতে দেয় না ───────────────────────────────
async function dirtyRead(): Promise<void> {
	await reset();
	console.log('\n   [B = READ UNCOMMITTED]  A নাম বদলাল কিন্তু COMMIT করেনি');
	const a = await begin(READ_COMMITTED);
	await exec(`UPDATE projects SET name = 'Draft name' WHERE id = 1`, a);
	log('A', `নাম বদলে "Draft name" — এখনো COMMIT করেনি`);
	const b = await begin(READ_UNCOMMITTED);
	log('B', `পড়ল: "${await readText('SELECT name AS v FROM projects WHERE id = 1', b)}"`);
	await b.commit();
	await a.rollback();
	log('A', 'ROLLBACK — "Draft name" কখনো সত্যি ছিল না');
	log('→', 'Postgres এ READ UNCOMMITTED আসলে READ COMMITTED এর মতো আচরণ করে');
}

async function main(): Promise<void> {
	heading('১. Lost update — read-modify-write');
	await lostUpdate(READ_COMMITTED);
	await lostUpdate(REPEATABLE_READ);
	await lostUpdateForUpdate();

	heading('২. Non-repeatable read');
	await nonRepeatableRead(READ_COMMITTED);
	await nonRepeatableRead(REPEATABLE_READ);

	heading('৩. Phantom read');
	await phantomRead(READ_COMMITTED);
	await phantomRead(REPEATABLE_READ);

	heading('৪. Write skew');
	await writeSkew(REPEATABLE_READ);
	await writeSkew(SERIALIZABLE);

	heading('৫. Dirty read');
	await dirtyRead();

	console.log('');
	await sequelize.close();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('anomalies failed:', error instanceof Error ? error.message : String(error));
	await sequelize.close();
	process.exit(1);
});
