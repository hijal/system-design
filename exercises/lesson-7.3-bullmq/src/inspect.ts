import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { connection, redisAddress } from './config';

// Lesson 7.3 §1.3 - inside BullMQ: create jobs in various states on a small queue and look at Redis's
// keys directly. (Key names and structure can change between BullMQ versions - this is for looking,
// not for relying on. In code always use BullMQ's API, never the keys directly.)

const NAME = 'inspect-demo';

async function main(): Promise<void> {
	const queue = new Queue(NAME, { connection });
	await queue.obliterate({ force: true });

	// two jobs the worker will process: one succeeds, one fails (1 attempt)
	await queue.add('ok', { n: 1 }, { jobId: 'demo-completed' });
	await queue.add('boom', { n: 2 }, { jobId: 'demo-failed', attempts: 1 });
	const worker = new Worker(
		NAME,
		async (job) => {
			if (job.name === 'boom') throw new Error('provider responded 503');
		},
		{ connection }
	);
	await new Promise<void>((resolve) => {
		let finished = 0;
		const done = (): void => {
			if (++finished === 2) resolve();
		};
		worker.on('completed', done);
		worker.on('failed', done);
	});
	await worker.close();

	// the rest without a worker - they stay in the state they were added in
	await queue.add('now', { n: 3 }, { jobId: 'demo-waiting' });
	await queue.add('later', { n: 4 }, { jobId: 'demo-delayed', delay: 60_000 });
	await queue.add('urgent', { n: 5 }, { jobId: 'demo-prioritized', priority: 1 });

	console.log('\n   job states (BullMQ API):');
	for (const id of [
		'demo-waiting',
		'demo-delayed',
		'demo-prioritized',
		'demo-completed',
		'demo-failed'
	]) {
		const job = await queue.getJob(id);
		console.log(`     ${id.padEnd(18)} → ${job ? await job.getState() : 'missing'}`);
	}

	// BullMQ's own client type has no generic commands - a separate ioredis client for looking
	const client = new Redis(redisAddress);
	const keys = (await client.keys(`bull:${NAME}:*`)).sort();
	console.log(`\n   Redis keys (bull:${NAME}:*):`);
	for (const key of keys) {
		const type = await client.type(key);
		let detail = '';
		if (type === 'list') detail = (await client.lrange(key, 0, -1)).join(', ');
		else if (type === 'zset') detail = (await client.zrange(key, 0, -1)).join(', ');
		else if (type === 'set') detail = (await client.smembers(key)).join(', ');
		else if (type === 'stream') detail = `${await client.xlen(key)} events`;
		console.log(`     ${key.replace(`bull:${NAME}:`, '').padEnd(20)} ${type.padEnd(7)} ${detail}`);
	}

	const hash = await client.hgetall(`bull:${NAME}:demo-failed`);
	console.log("\n   one job's hash (demo-failed), some fields:");
	for (const field of ['name', 'data', 'opts', 'failedReason', 'timestamp', 'finishedOn'])
		if (hash[field] !== undefined) console.log(`     ${field.padEnd(13)} ${hash[field]}`);

	client.disconnect();
	await queue.obliterate({ force: true });
	await queue.close();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
