import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { connection, redisAddress } from './config';

// Lesson 7.3 §১.৩ — BullMQ এর ভেতরে: একটা ছোট queue তে বিভিন্ন অবস্থার job বানিয়ে Redis এর
// key গুলো সরাসরি দেখা। (Key এর নাম আর গঠন BullMQ এর version ভেদে বদলাতে পারে — এটা দেখার জন্য,
// নির্ভর করার জন্য না। Code এ সবসময় BullMQ এর API ব্যবহার করো, key সরাসরি না।)

const NAME = 'inspect-demo';

async function main(): Promise<void> {
	const queue = new Queue(NAME, { connection });
	await queue.obliterate({ force: true });

	// দুটো job worker প্রক্রিয়া করবে: একটা সফল, একটা ব্যর্থ (১ বার চেষ্টা)
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

	// বাকিগুলো worker ছাড়া — যে অবস্থায় যোগ হয় সেখানেই থাকে
	await queue.add('now', { n: 3 }, { jobId: 'demo-waiting' });
	await queue.add('later', { n: 4 }, { jobId: 'demo-delayed', delay: 60_000 });
	await queue.add('urgent', { n: 5 }, { jobId: 'demo-prioritized', priority: 1 });

	console.log('\n   job এর অবস্থা (BullMQ API):');
	for (const id of [
		'demo-waiting',
		'demo-delayed',
		'demo-prioritized',
		'demo-completed',
		'demo-failed'
	]) {
		const job = await queue.getJob(id);
		console.log(`     ${id.padEnd(18)} → ${job ? await job.getState() : 'নেই'}`);
	}

	// BullMQ এর নিজের client এর type এ সাধারণ command নেই — দেখার জন্য আলাদা একটা ioredis client
	const client = new Redis(redisAddress);
	const keys = (await client.keys(`bull:${NAME}:*`)).sort();
	console.log(`\n   Redis এর key (bull:${NAME}:*):`);
	for (const key of keys) {
		const type = await client.type(key);
		let detail = '';
		if (type === 'list') detail = (await client.lrange(key, 0, -1)).join(', ');
		else if (type === 'zset') detail = (await client.zrange(key, 0, -1)).join(', ');
		else if (type === 'set') detail = (await client.smembers(key)).join(', ');
		else if (type === 'stream') detail = `${await client.xlen(key)} টা event`;
		console.log(`     ${key.replace(`bull:${NAME}:`, '').padEnd(20)} ${type.padEnd(7)} ${detail}`);
	}

	const hash = await client.hgetall(`bull:${NAME}:demo-failed`);
	console.log('\n   একটা job এর hash (demo-failed), কিছু field:');
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
