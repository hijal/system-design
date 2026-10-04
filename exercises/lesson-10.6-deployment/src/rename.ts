import {
	DataTypes,
	Model,
	QueryTypes,
	Sequelize,
	type CreationOptional,
	type InferAttributes,
	type InferCreationAttributes
} from 'sequelize';
import { env, heading, mulberry32, n, row, sleep } from './util';

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5449/taskflow';
const BOARDS = env('BOARDS', 20_000);
const INSTANCES = env('INSTANCES', 4);
const STEP_SECONDS = env('STEP_SECONDS', 1);

const sequelize = new Sequelize(DATABASE_URL, {
	logging: false,
	pool: { max: INSTANCES * 2 + 2, min: 0, idle: 10_000 }
});

class BoardV1 extends Model<InferAttributes<BoardV1>, InferCreationAttributes<BoardV1>> {
	declare id: CreationOptional<number>;
	declare workspaceId: number;
	declare title: string;
}

class BoardBoth extends Model<InferAttributes<BoardBoth>, InferCreationAttributes<BoardBoth>> {
	declare id: CreationOptional<number>;
	declare workspaceId: number;
	declare title: string | null;
	declare name: string | null;
}

class BoardV2 extends Model<InferAttributes<BoardV2>, InferCreationAttributes<BoardV2>> {
	declare id: CreationOptional<number>;
	declare workspaceId: number;
	declare name: string;
}

const table = { sequelize, tableName: 'boards', timestamps: false, underscored: true };
const id = { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true };
const workspaceId = { type: DataTypes.INTEGER, allowNull: false };
BoardV1.init({ id, workspaceId, title: { type: DataTypes.TEXT, allowNull: false } }, table);
BoardBoth.init(
	{
		id,
		workspaceId,
		title: { type: DataTypes.TEXT, allowNull: true },
		name: { type: DataTypes.TEXT, allowNull: true }
	},
	table
);
BoardV2.init({ id, workspaceId, name: { type: DataTypes.TEXT, allowNull: false } }, table);

type Version = 'v1' | 'v1.5' | 'v2r' | 'v2';

async function readBoard(version: Version, boardId: number): Promise<string | null> {
	if (version === 'v1') return (await BoardV1.findByPk(boardId))?.title ?? null;
	if (version === 'v2') return (await BoardV2.findByPk(boardId))?.name ?? null;
	const board = await BoardBoth.findByPk(boardId);
	return (version === 'v1.5' ? board?.title : board?.name) ?? null;
}

async function writeBoard(version: Version, boardId: number, value: string): Promise<void> {
	if (version === 'v1') await BoardV1.update({ title: value }, { where: { id: boardId } });
	else if (version === 'v2') await BoardV2.update({ name: value }, { where: { id: boardId } });
	else await BoardBoth.update({ title: value, name: value }, { where: { id: boardId } });
}

async function createBoard(version: Version, value: string): Promise<number> {
	if (version === 'v1') return (await BoardV1.create({ workspaceId: 1, title: value })).id;
	if (version === 'v2') return (await BoardV2.create({ workspaceId: 1, name: value })).id;
	return (await BoardBoth.create({ workspaceId: 1, title: value, name: value })).id;
}

type Truth = { value: string; at: number };
const truth = new Map<number, Truth>();
const writing = new Map<number, number>();
let maxId = BOARDS;

const contested = new Set<number>();

const busy = (boardId: number): boolean => (writing.get(boardId) ?? 0) > 0;
const begin = (boardId: number): void => {
	if (busy(boardId)) contested.add(boardId);
	writing.set(boardId, (writing.get(boardId) ?? 0) + 1);
};
const end = (boardId: number): void => {
	writing.set(boardId, (writing.get(boardId) ?? 1) - 1);
	if (!busy(boardId) && contested.delete(boardId)) truth.delete(boardId);
};

type Tally = { ops: number; errors: number; stale: number; firstError: string };
type Step = {
	label: string;
	running: string;
	seconds: number;
	versionAt: (instance: number, t: number) => Version;
	actions?: { at: number; run: () => Promise<string> }[];
};

const rolling =
	(from: Version, to: Version, start = 1) =>
	(instance: number, t: number): Version =>
		t >= start + instance * STEP_SECONDS ? to : from;
const only = (version: Version) => (): Version => version;

const message = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

async function migrate(sql: string): Promise<string> {
	await sequelize.transaction(async (transaction) => {
		await sequelize.query("SET LOCAL lock_timeout = '2s'", { transaction });
		await sequelize.query(sql, { transaction });
	});
	return '';
}

const MISMATCH = 'SELECT count(*) AS count FROM boards WHERE name IS DISTINCT FROM title';

async function backfill(when: 'distinct' | 'null' = 'distinct'): Promise<string> {
	const condition = when === 'distinct' ? 'name IS DISTINCT FROM title' : 'name IS NULL';
	let batches = 0;
	let changed = 0;
	for (let from = 0; from < maxId; from += 2_000) {
		const [, affected] = await sequelize.query(
			`UPDATE boards SET name = title WHERE id > :from AND id <= :to AND ${condition}`,
			{ replacements: { from, to: from + 2_000 }, type: QueryTypes.UPDATE }
		);
		changed += affected;
		batches++;
		await sleep(10);
	}
	return `backfill (${condition}): ${batches}টা batch, ${n(changed)}টা row বদলাল; এখন name ≠ title: ${n(await count(MISMATCH))}`;
}

async function count(sql: string): Promise<number> {
	const [rows] = await sequelize.query(sql);
	const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
	if (typeof first === 'object' && first !== null && 'count' in first) return Number(first.count);
	return Number.NaN;
}

async function run(step: Step, seed: number): Promise<Tally> {
	const random = mulberry32(seed);
	const tally: Tally = { ops: 0, errors: 0, stale: 0, firstError: '' };
	const notes: string[] = [];
	const started = performance.now();
	const elapsed = (): number => (performance.now() - started) / 1_000;
	let counter = 0;
	const loop = async (instance: number): Promise<void> => {
		while (elapsed() < step.seconds) {
			const version = step.versionAt(instance, elapsed());
			const pick = random();
			const boardId = 1 + Math.floor(random() * maxId);
			const opStart = performance.now();
			try {
				if (pick < 0.6) {
					const expected = truth.get(boardId);
					const quietBefore = !busy(boardId);
					const value = await readBoard(version, boardId);
					const quiet = quietBefore && !busy(boardId) && truth.get(boardId) === expected;
					if (expected && quiet && expected.at < opStart && value !== expected.value) tally.stale++;
				} else if (pick < 0.95) {
					const value = `${version}-${seed}-${counter++}`;
					begin(boardId);
					try {
						await writeBoard(version, boardId, value);
						truth.set(boardId, { value, at: performance.now() });
					} finally {
						end(boardId);
					}
				} else {
					const value = `${version}-${seed}-${counter++}`;
					const created = await createBoard(version, value);
					maxId = Math.max(maxId, created);
					truth.set(created, { value, at: performance.now() });
				}
			} catch (error: unknown) {
				tally.errors++;
				if (!tally.firstError) tally.firstError = `${version}: ${message(error)}`;
			}
			tally.ops++;
			await sleep(4);
		}
	};
	const actions = (step.actions ?? []).map(async (action) => {
		await sleep(action.at * 1_000);
		const note = await action.run();
		if (note) notes.push(note);
	});
	await Promise.all([
		...Array.from({ length: INSTANCES }, (_, i) => loop(i)),
		...Array.from({ length: INSTANCES }, (_, i) => loop(i)),
		...actions
	]);
	if (notes.length > 0 && !tally.firstError) tally.firstError = notes.join('; ');
	else if (notes.length > 0) tally.firstError = `${notes.join('; ')}; ${tally.firstError}`;
	return tally;
}

async function fresh(): Promise<void> {
	truth.clear();
	writing.clear();
	contested.clear();
	maxId = BOARDS;
	await sequelize.query('DROP TABLE IF EXISTS boards');
	await sequelize.query(
		'CREATE TABLE boards (id serial PRIMARY KEY, workspace_id int NOT NULL, title text NOT NULL)'
	);
	await sequelize.query(
		`INSERT INTO boards (workspace_id, title) SELECT (g % 2000) + 1, 'board ' || g FROM generate_series(1, ${BOARDS}) g`
	);
	await sequelize.query("SELECT setval('boards_id_seq', (SELECT max(id) FROM boards))");
	for (let i = 1; i <= BOARDS; i++) truth.set(i, { value: `board ${i}`, at: 0 });
}

function header(): void {
	console.log(
		row([
			['ধাপ', 44],
			['চলছে', 14],
			['op', 8],
			['error', 8],
			['ভুল পড়া', 10]
		])
	);
}

async function play(steps: Step[], seedBase: number): Promise<void> {
	for (const [index, step] of steps.entries()) {
		const t = await run(step, seedBase + index);
		console.log(
			row([
				[step.label, 44],
				[step.running, 14],
				[n(t.ops), 8],
				[n(t.errors), 8],
				[n(t.stale), 10]
			])
		);
		if (t.firstError) console.log(`   ${t.firstError}`);
	}
}

const EXPAND = 'ALTER TABLE boards ADD COLUMN name text, ALTER COLUMN title DROP NOT NULL';

async function main(): Promise<void> {
	console.log(
		`boards এ ${n(BOARDS)}টা row; ${INSTANCES}টা instance (প্রত্যেকে দুটো loop: ৬০% পড়া, ৩৫% লেখা, ৫% নতুন); rolling এ প্রতি ${STEP_SECONDS} s এ একটা instance`
	);
	console.log(
		'version: v1 = title পড়ে-লেখে · v1.5 = দুটোতে লেখে, title পড়ে · v2r = দুটোতে লেখে, name পড়ে · v2 = শুধু name'
	);

	heading('অংশ ক — এক ধাপে rename: title → name');
	header();
	await fresh();
	await play(
		[
			{
				label: 'migration আগে, তারপর deploy',
				running: 'v1 → v2',
				seconds: 6,
				versionAt: rolling('v1', 'v2', 2),
				actions: [{ at: 1, run: () => migrate('ALTER TABLE boards RENAME COLUMN title TO name') }]
			}
		],
		10
	);
	await fresh();
	await play(
		[
			{
				label: 'deploy আগে, তারপর migration',
				running: 'v1 → v2',
				seconds: 6,
				versionAt: rolling('v1', 'v2', 1),
				actions: [{ at: 5, run: () => migrate('ALTER TABLE boards RENAME COLUMN title TO name') }]
			},
			{
				label: 'তারপর rollback (migration ফেরানো হয়নি)',
				running: 'v2 → v1',
				seconds: 5,
				versionAt: rolling('v2', 'v1', 1)
			}
		],
		20
	);

	heading('অংশ খ — expand / migrate / contract');
	header();
	await fresh();
	await play(
		[
			{
				label: '১. expand: name যোগ, title এর NOT NULL তোলা',
				running: 'v1',
				seconds: 3,
				versionAt: only('v1'),
				actions: [{ at: 1, run: () => migrate(EXPAND) }]
			},
			{
				label: '২. deploy: দুটোতে লেখা',
				running: 'v1 → v1.5',
				seconds: 6,
				versionAt: rolling('v1', 'v1.5')
			},
			{
				label: '৩. backfill: name = title, batch এ',
				running: 'v1.5',
				seconds: 4,
				versionAt: only('v1.5'),
				actions: [{ at: 0.5, run: () => backfill() }]
			},
			{
				label: '৪. deploy: name থেকে পড়া',
				running: 'v1.5 → v2r',
				seconds: 6,
				versionAt: rolling('v1.5', 'v2r')
			},
			{
				label: '   rollback পরীক্ষা',
				running: 'v2r → v1.5',
				seconds: 6,
				versionAt: rolling('v2r', 'v1.5')
			},
			{
				label: '   আবার এগোনো',
				running: 'v1.5 → v2r',
				seconds: 6,
				versionAt: rolling('v1.5', 'v2r')
			},
			{
				label: '৫. deploy: শুধু name এ লেখা',
				running: 'v2r → v2',
				seconds: 6,
				versionAt: rolling('v2r', 'v2')
			},
			{
				label: '৬. contract: title মোছা',
				running: 'v2',
				seconds: 3,
				versionAt: only('v2'),
				actions: [{ at: 1, run: () => migrate('ALTER TABLE boards DROP COLUMN title') }]
			}
		],
		30
	);
	console.log(
		`   শেষে name ফাঁকা এমন row: ${n(await count('SELECT count(*) AS count FROM boards WHERE name IS NULL'))}`
	);

	heading('অংশ গ — চারটা পরিচিত ভুল');
	header();
	await fresh();
	await migrate(EXPAND);
	await backfill();
	await play(
		[
			{
				label: 'dual-write বাদ: expand + backfill → সরাসরি v2',
				running: 'v1 → v2',
				seconds: 6,
				versionAt: rolling('v1', 'v2')
			}
		],
		50
	);
	console.log(
		`   এখন name আর title আলাদা এমন row: ${n(await count('SELECT count(*) AS count FROM boards WHERE name IS DISTINCT FROM title'))}`
	);
	await fresh();
	await migrate(EXPAND);
	await backfill();
	await play(
		[
			{
				label: 'contract আগেভাগে: v1.5 এখনও চলছে',
				running: 'v1.5 → v2',
				seconds: 6,
				versionAt: rolling('v1.5', 'v2'),
				actions: [{ at: 2.5, run: () => migrate('ALTER TABLE boards DROP COLUMN title') }]
			}
		],
		60
	);
	await fresh();
	await migrate('ALTER TABLE boards ADD COLUMN name text');
	await backfill();
	await play(
		[
			{
				label: 'expand এ title এর NOT NULL তোলা হয়নি',
				running: 'v2r → v2',
				seconds: 6,
				versionAt: rolling('v2r', 'v2')
			}
		],
		70
	);
	await fresh();
	await migrate(EXPAND);
	await play(
		[
			{
				label: 'backfill এর শর্ত name IS NULL',
				running: 'v1 → v1.5',
				seconds: 6,
				versionAt: rolling('v1', 'v1.5')
			},
			{
				label: '   তারপর name থেকে পড়া',
				running: 'v1.5 → v2r',
				seconds: 6,
				versionAt: rolling('v1.5', 'v2r'),
				actions: [{ at: 0, run: () => backfill('null') }]
			}
		],
		80
	);
	await sequelize.close();
}

main().catch(async (error: unknown) => {
	console.error(error);
	await sequelize.close();
	process.exitCode = 1;
});
