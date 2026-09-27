import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Comment, OutboxEvent, sequelize } from './db';
import { connectRedis, publish, waitReady, type CommentCreated } from './events';

// Lesson 7.5 — "comment তৈরি করো, আর comment.created event পাঠাও" এর তিনটা সংস্করণ:
//
//   commit-first   — database commit, তারপর Redis এ event          (dual write, ক্রম ১)
//   publish-first  — transaction খুলে লেখা, event পাঠানো, তারপর commit (dual write, ক্রম ২)
//   outbox         — comment আর outbox row একই transaction এ; পাঠায় relay.ts
//
// CRASH_RATE অনুপাতে (comment এর id থেকে নির্ধারিত, তাই প্রতিবার একই) ঠিক সবচেয়ে খারাপ মুহূর্তে process
// নিজেকে SIGKILL করে — deploy বা crash এর মতো। Scenario নতুন writer চালায়, পরের id থেকে।

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

// id থেকে একটা স্থির "random" সংখ্যা — একই id তে প্রতিবার একই সিদ্ধান্ত
function unit(id: number): number {
	let x = Math.imul(id ^ (env.SEED * 0x9e3779b1), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const redis = connectRedis();
redis.on('error', () => {}); // সংযোগের error publish() এর throw তে ধরা পড়ে

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
			if (crash) die(); // commit হয়ে গেছে, event এখনো যায়নি
			try {
				await publish(redis, event);
			} catch {
				// comment সেভ হয়েছে — user কে 201 দেওয়া হয়, event এর ব্যর্থতা শুধু log এ
				process.send?.({ publishFailed: id });
			}
			return;
		}
		case 'publish-first': {
			const t = await sequelize.transaction();
			try {
				await Comment.create({ id, taskId, body: `comment ${id}` }, { transaction: t });
				await publish(redis, event);
				if (crash) die(); // event চলে গেছে, transaction এখনো খোলা — connection ছিঁড়লে Postgres rollback করে
				await t.commit();
			} catch {
				await t.rollback();
				// event না গেলে comment ও না — user error দেখে
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
				if (crash) die(); // দুটোই লেখা, commit এর আগে — দুটোই rollback হবে, একসাথে
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
