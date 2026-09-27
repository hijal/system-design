import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { OutboxEvent, sequelize } from './db';
import { commentCreatedSchema, connectRedis, publish, waitReady } from './events';

// Lesson 7.5 — Outbox relay: outbox table থেকে না-পাঠানো event তুলে Redis Stream এ পাঠায়।
//
// প্রতিটা চক্র একটা transaction: `FOR UPDATE SKIP LOCKED` দিয়ে একটা batch নেয় (একাধিক relay চললে
// একই row দুজন নেয় না), প্রতিটা event পাঠায়, তারপর publishedAt বসিয়ে commit।
// পাঠানো আর "পাঠিয়েছি" লেখার মাঝে crash হলে পরের relay সেগুলো আবার পাঠায় — at-least-once (7.4)।

const env = z
	.object({
		POLL_MS: z.coerce.number().int().positive().default(200),
		BATCH: z.coerce.number().int().positive().default(50),
		CRASH_RATE: z.coerce.number().min(0).max(1).default(0),
		SEED: z.coerce.number().int().default(7),
		// প্রতিবার নতুন relay এর জন্য আলাদা — নইলে restart এর পরে একই row এ আবার crash করত
		GENERATION: z.coerce.number().int().nonnegative().default(0)
	})
	.parse(process.env);

type Row = { id: string; payload: unknown };

// writer.ts এর hash থেকে আলাদা (বাড়তি salt) — নইলে writer যে id তে crash করে (আর সেই row rollback হয়)
// relay ও ঠিক সেগুলোতেই crash করতে চাইত, আর কখনো crash ই করত না
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
			// outbox এর payload JSONB — লিখেছে writer, কিন্তু runtime এ যাচাই (পুরনো version এর row ও থাকতে পারে)
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
			// Redis বা Postgres নেই — transaction rollback হয়েছে, row গুলো আবার পরের বার আসবে
			console.error('relay:', error instanceof Error ? error.message : error);
			await sleep(1000);
		}
	}
}

main().catch((error: unknown) => {
	console.error('relay:', error instanceof Error ? error.message : error);
	process.exit(1);
});
