import {
	DataTypes,
	Model,
	QueryTypes,
	Sequelize,
	type CreationOptional,
	type InferAttributes,
	type InferCreationAttributes
} from 'sequelize';
import { z } from 'zod';

const HOST = process.env.DB_HOST ?? 'localhost';
const PRIMARY_PORT = Number(process.env.PRIMARY_PORT ?? 5438);
const REPLICA_PORT = Number(process.env.REPLICA_PORT ?? 5439);
const credentials = { username: 'taskflow', password: 'taskflow', database: 'taskflow' };

// TaskFlow এর app connection — Sequelize এর built-in read replication।
// Transaction এর বাইরের SELECT যায় `read` pool এ (replica), বাকি সব `write` এ (primary)।
// ঠিক এই সুবিধাটাই read-your-writes bug এর জন্ম দেয় (lag.ts)।
export const app = new Sequelize({
	dialect: 'postgres',
	logging: false,
	replication: {
		read: [{ host: HOST, port: REPLICA_PORT, ...credentials }],
		write: { host: HOST, port: PRIMARY_PORT, ...credentials }
	},
	pool: { max: 10, min: 0, idle: 10_000 }
});

// সরাসরি connection — admin কাজ আর মাপার জন্য (LSN, lag, setting)
function direct(port: number): Sequelize {
	return new Sequelize({ dialect: 'postgres', logging: false, host: HOST, port, ...credentials });
}
export const primary = direct(PRIMARY_PORT);
export const replica = direct(REPLICA_PORT);

export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare title: string;
}
Task.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		title: { type: DataTypes.STRING, allowNull: false }
	},
	{ sequelize: app, tableName: 'tasks', timestamps: false }
);

const textRow = z.array(z.object({ v: z.string() })).length(1);
const boolRow = z.array(z.object({ v: z.boolean() })).length(1);

export async function scalarText(db: Sequelize, sql: string): Promise<string> {
	const rows = textRow.parse(await db.query(sql, { type: QueryTypes.SELECT }));
	return rows[0]?.v ?? '';
}

export async function scalarBool(
	db: Sequelize,
	sql: string,
	replacements: Record<string, string> = {}
): Promise<boolean> {
	const rows = boolRow.parse(await db.query(sql, { type: QueryTypes.SELECT, replacements }));
	return rows[0]?.v ?? false;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Replica তে কৃত্রিম lag: WAL পেয়ে গেলেও প্রয়োগ করার আগে এতক্ষণ অপেক্ষা করবে।
// recovery_min_apply_delay একটা আসল Postgres setting (ইচ্ছাকৃত "delayed replica" বানাতে
// ব্যবহার হয়) — এখানে ভারী load বা দূরের network এর lag নকল করতে।
export async function setApplyDelay(ms: number): Promise<void> {
	await replica.query(`ALTER SYSTEM SET recovery_min_apply_delay = '${ms}ms'`);
	await replica.query('SELECT pg_reload_conf()');
	const expected = ms === 0 ? '0' : `${ms}ms`;
	for (let i = 0; i < 50; i++) {
		if (
			(await scalarText(replica, "SELECT current_setting('recovery_min_apply_delay') AS v")) ===
			expected
		)
			return;
		await sleep(100);
	}
	throw new Error('replica did not pick up recovery_min_apply_delay');
}

// Replica কি primary এর বর্তমান অবস্থা পর্যন্ত পৌঁছেছে? (প্রতিটা ধাপের আগে পরিষ্কার শুরু)
export async function waitForCatchUp(): Promise<void> {
	const lsn = await scalarText(primary, 'SELECT pg_current_wal_lsn()::text AS v');
	await waitForReplay(lsn);
}

// Replica এর প্রয়োগ করা WAL অবস্থান (LSN) একটা নির্দিষ্ট বিন্দু পার হওয়া পর্যন্ত অপেক্ষা
export async function waitForReplay(lsn: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const caught = await scalarBool(
			replica,
			'SELECT pg_last_wal_replay_lsn() >= :lsn::pg_lsn AS v',
			{ lsn }
		);
		if (caught) return;
		await sleep(2);
	}
	throw new Error(`replica did not reach ${lsn}`);
}

export async function closeAll(): Promise<void> {
	await Promise.all([app.close(), primary.close(), replica.close()]);
}
