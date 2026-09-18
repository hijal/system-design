import http from 'node:http';
import { z } from 'zod';
import { invalidate, keys, redis } from './cache';

// Lesson 4.6 — cache stampede চোখে দেখার script.
// একটা জনপ্রিয় key এর TTL শেষ হওয়ার মুহূর্তে যদি N টা request একসাথে আসে,
// তাহলে N টাই miss করে, আর N টাই DB তে ঝাঁপিয়ে পড়ে। সেটাই এখানে মাপা হয়।
const HOST = process.env.HOST ?? 'localhost';
const PORT = Number(process.env.PORT ?? 3000);
const USER_ID = 7;
const CONCURRENCY = 50;
// একটা "দামি query" নকল — নাহলে stampede এর জানালাটাই থাকে না (নিচে ব্যাখ্যা)
const QUERY_MS = 200;

// গুরুত্বপূর্ণ: Node এর built-in fetch (undici) origin প্রতি অল্প কয়েকটা
// connection খোলে, তাই Promise.all দিয়ে ৫০টা fetch পাঠালেও সেগুলো আসলে
// ৫-৬টা করে ধাপে যায় — অর্থাৎ সত্যিকারের একসাথে না। তখন প্রথম batch এর
// উত্তর cache এ বসে যায় আর stampede টা ঘটেই না।
// তাই এখানে নিজের agent, maxSockets বাড়িয়ে — যাতে ৫০টা সত্যিই একসাথে যায়।
const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY * 2 });

function get(path: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const req = http.get({ host: HOST, port: PORT, path, agent }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => (body += chunk));
			res.on('end', () => resolve(body));
		});
		req.on('error', reject);
	});
}

function post(path: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const req = http.request({ host: HOST, port: PORT, path, method: 'POST', agent }, (res) => {
			res.resume();
			res.on('end', () => resolve());
		});
		req.on('error', reject);
		req.end();
	});
}

const statsSchema = z.object({ dbQueryCount: z.number() });

async function dbCount(): Promise<number> {
	const parsed: unknown = JSON.parse(await get('/api/_stats'));
	return statsSchema.parse(parsed).dbQueryCount;
}

async function burst(singleFlight: boolean): Promise<{ dbQueries: number; ms: number }> {
	// key মুছে দেওয়া = TTL শেষ হওয়ার মুহূর্তটা নকল করা
	await invalidate(keys.tasksByUser(USER_ID));
	await post('/api/_stats/reset');
	// TCP connection গুলো আগেই খুলে নাও, যাতে burst এর সময় connection
	// setup টা critical path এ না থাকে
	await Promise.all(Array.from({ length: CONCURRENCY }, () => get('/api/_stats')));

	const path = `/api/tasks?userId=${USER_ID}&delay=${QUERY_MS}${singleFlight ? '&sf=1' : ''}`;
	const started = Date.now();
	// ঠিক একই মুহূর্তে CONCURRENCY টা request — এটাই stampede
	await Promise.all(Array.from({ length: CONCURRENCY }, () => get(path)));
	const ms = Date.now() - started;

	return { dbQueries: await dbCount(), ms };
}

async function main(): Promise<void> {
	console.log(`\n  ${CONCURRENCY} টা request একসাথে, cache সদ্য খালি, DB query ~${QUERY_MS}ms:\n`);

	const naive = await burst(false);
	console.log(
		`  single-flight ছাড়া : DB query ${String(naive.dbQueries).padStart(3)} টা   (${naive.ms} ms)`
	);

	const guarded = await burst(true);
	console.log(
		`  single-flight সহ   : DB query ${String(guarded.dbQueries).padStart(3)} টা   (${guarded.ms} ms)`
	);

	console.log(
		`\n  বাঁচানো গেল       : ${naive.dbQueries - guarded.dbQueries} টা অপ্রয়োজনীয় DB query\n`
	);

	agent.destroy();
	await redis.quit();
}

main().catch((error: unknown): void => {
	console.error('stampede demo failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
