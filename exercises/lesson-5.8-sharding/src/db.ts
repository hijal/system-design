import { QueryTypes, Sequelize } from 'sequelize';
import { z } from 'zod';

const HOST = process.env.DB_HOST ?? 'localhost';
const PORTS = [5440, 5441, 5442];

function connect(port: number): Sequelize {
	return new Sequelize({
		dialect: 'postgres',
		host: HOST,
		port,
		username: 'taskflow',
		password: 'taskflow',
		database: 'taskflow',
		logging: false,
		pool: { max: 5, min: 0, idle: 10_000 }
	});
}

// প্রতিটা shard একটা সম্পূর্ণ আলাদা database — আলাদা machine হলে যেমন হতো
export const shards: Sequelize[] = PORTS.map(connect);

export function shardAt(index: number): Sequelize {
	const shard = shards[index];
	if (!shard) throw new Error(`no shard ${index}`);
	return shard;
}

export async function closeAll(): Promise<void> {
	await Promise.all(shards.map((s) => s.close()));
}

const numberRow = z.array(z.object({ v: z.coerce.number() })).length(1);

export async function scalar(
	db: Sequelize,
	sql: string,
	replacements: Record<string, string | number> = {}
): Promise<number> {
	const rows = numberRow.parse(await db.query(sql, { type: QueryTypes.SELECT, replacements }));
	return rows[0]?.v ?? Number.NaN;
}
