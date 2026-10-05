import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { OutboxEvent, sequelize } from './db';
import { commentCreatedSchema, connectRedis, publish, waitReady } from './events';

// Lesson 7.5 — the outbox relay: picks unsent events from the outbox table and sends them to the Redis Stream.
//
// Every cycle is one transaction: takes a batch with `FOR UPDATE SKIP LOCKED` (with several relays running
// no two take the same row), sends each event, then sets publishedAt and commits.
// A crash between sending and writing "sent" makes the next relay send them again — at-least-once (7.4).

const env = z
	.object({
		POLL_MS: z.coerce.number().int().positive().default(200),
		BATCH: z.coerce.number().int().positive().default(50),
		CRASH_RATE: z.coerce.number().min(0).max(1).default(0),
		SEED: z.coerce.number().int().default(7),
		// different for every new relay — otherwise after a restart it would crash on the same row again
		GENERATION: z.coerce.number().int().nonnegative().default(0)
	})
	.parse(process.env);

type Row = { id: string; payload: unknown };

// different from writer.ts's hash (an extra salt) — otherwise the relay would want to crash on exactly the ids
// the writer crashes on (and those rows are rolled back), and would never crash at all
function unit(id: number): number {
	let x = Math.imul(
		id ^ (env.SEED * 0x9e3779b1) ^ ((env.GENERATION + 1) * 0x27d4eb2f) ^ 0x5bd1e995,
		0x85ebca6b
	);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const redis = connectRedis();
redis.on('error', () => {});
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function cycle(): Promise<number> {
	return sequelize.transaction(async (t) => {
		const rows = await sequelize.query<Row>(
			`SELECT id, payload FROM outbox_events
			 WHERE "publishedAt" IS NULL
			 ORDER BY id
			 LIMIT :batch
			 FOR UPDATE SKIP LOCKED`,
			{ replacements: { batch: env.BATCH }, type: QueryTypes.SELECT, transaction: t }
		);
		for (const row of rows) {
			// the outbox payload is JSONB — written by the writer, but validated at runtime (rows from an older version may exist too)
			await publish(redis, commentCreatedSchema.parse(row.payload));
			if (unit(Number(row.id)) < env.CRASH_RATE) process.kill(process.pid, 'SIGKILL');
		}
		if (rows.length > 0)
			await OutboxEvent.update(
				{ publishedAt: new Date() },
				{ where: { id: rows.map((r) => r.id) }, transaction: t }
			);
		return rows.length;
	});
}

async function main(): Promise<void> {
	await sequelize.authenticate();
	await waitReady(redis);
	process.send?.({ ready: true });
	for (;;) {
		try {
			const sent = await cycle();
			if (sent === 0) await sleep(env.POLL_MS);
		} catch (error: unknown) {
			// Redis or Postgres is missing — the transaction rolled back, the rows will come again next time
			console.error('relay:', error instanceof Error ? error.message : error);
			await sleep(1000);
		}
	}
}

main().catch((error: unknown) => {
	console.error('relay:', error instanceof Error ? error.message : error);
	process.exit(1);
});
