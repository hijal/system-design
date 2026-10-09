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

// TaskFlow's app connection - Sequelize's built-in read replication.
// SELECTs outside a transaction go to the `read` pool (the replica), everything else to `write` (the primary).
// Exactly this convenience gives birth to the read-your-writes bug (lag.ts).
export const app = new Sequelize({
	dialect: 'postgres',
	logging: false,
	replication: {
		read: [{ host: HOST, port: REPLICA_PORT, ...credentials }],
		write: { host: HOST, port: PRIMARY_PORT, ...credentials }
	},
	pool: { max: 10, min: 0, idle: 10_000 }
});

// a direct connection - for admin work and measuring (LSN, lag, settings)
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

// Artificial lag on the replica: even after receiving the WAL it waits this long before applying it.
// recovery_min_apply_delay is a real Postgres setting (used to build a deliberate "delayed replica")
// - here it imitates the lag of heavy load or a distant network.
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

// Has the replica reached the primary's current state? (a clean start before every step)
export async function waitForCatchUp(): Promise<void> {
	const lsn = await scalarText(primary, 'SELECT pg_current_wal_lsn()::text AS v');
	await waitForReplay(lsn);
}

// Wait until the replica's applied WAL position (LSN) passes a given point
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
