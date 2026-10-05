import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Comment, OutboxEvent, sequelize } from './db';
import { connectRedis, publish, waitReady, type CommentCreated } from './events';

// Lesson 7.5 — three versions of "create a comment, and send the comment.created event":
//
//   commit-first   — database commit, then the event to Redis          (dual write, order 1)
//   publish-first  — open a transaction and write, send the event, then commit (dual write, order 2)
//   outbox         — the comment and the outbox row in the same transaction; relay.ts sends it
//
// In proportion to CRASH_RATE (decided from the comment's id, so the same every time) the process SIGKILLs
// itself at exactly the worst moment — like a deploy or a crash. The scenario starts a new writer, from the next id.

const env = z
	.object({
		MODE: z.enum(['commit-first', 'publish-first', 'outbox']),
		FROM: z.coerce.number().int().positive(),
		TO: z.coerce.number().int().positive(),
		CRASH_RATE: z.coerce.number().min(0).max(1).default(0),
		SEED: z.coerce.number().int().default(7),
		WRITE_DELAY_MS: z.coerce.number().int().nonnegative().default(0)
	})
	.parse(process.env);

// a fixed "random" number from the id — the same decision for the same id every time
function unit(id: number): number {
	let x = Math.imul(id ^ (env.SEED * 0x9e3779b1), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const redis = connectRedis();
redis.on('error', () => {}); // connection errors are caught in publish()'s throw

function die(): never {
	process.kill(process.pid, 'SIGKILL');
	throw new Error('unreachable');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function createComment(id: number): Promise<void> {
	const taskId = (id % 100) + 1;
	const crash = unit(id) < env.CRASH_RATE;
	const event: CommentCreated = {
		eventId: randomUUID(),
		type: 'comment.created',
		version: 1,
		occurredAt: new Date().toISOString(),
		taskId,
		commentId: id
	};

	switch (env.MODE) {
		case 'commit-first': {
			await sequelize.transaction(async (t) => {
				await Comment.create({ id, taskId, body: `comment ${id}` }, { transaction: t });
			});
			if (crash) die(); // committed, but the event hasn't gone yet
			try {
				await publish(redis, event);
			} catch {
				// the comment is saved — the user gets 201, the event's failure is only in the log
				process.send?.({ publishFailed: id });
			}
			return;
		}
		case 'publish-first': {
			const t = await sequelize.transaction();
			try {
				await Comment.create({ id, taskId, body: `comment ${id}` }, { transaction: t });
				await publish(redis, event);
				if (crash) die(); // the event has gone, the transaction is still open — if the connection drops Postgres rolls back
				await t.commit();
			} catch {
				await t.rollback();
				// no event means no comment either — the user sees an error
				process.send?.({ rejected: id });
			}
			return;
		}
		case 'outbox': {
			await sequelize.transaction(async (t) => {
				await Comment.create({ id, taskId, body: `comment ${id}` }, { transaction: t });
				await OutboxEvent.create(
					{
						eventId: event.eventId,
						type: event.type,
						aggregateId: taskId,
						payload: event,
						publishedAt: null
					},
					{ transaction: t }
				);
				if (crash) die(); // both written, before the commit — both will roll back, together
			});
			return;
		}
	}
}

async function main(): Promise<void> {
	await sequelize.authenticate();
	await waitReady(redis);
	for (let id = env.FROM; id <= env.TO; id++) {
		process.send?.({ started: id });
		await createComment(id);
		if (env.WRITE_DELAY_MS) await sleep(env.WRITE_DELAY_MS);
	}
	redis.disconnect();
	await sequelize.close();
}

main().catch((error: unknown) => {
	console.error('writer:', error instanceof Error ? error.message : error);
	process.exit(1);
});
