import http from 'node:http';
import { z } from 'zod';
import { invalidate, keys, redis } from './cache';

// Lesson 4.6 — a script to see a cache stampede with your own eyes.
// If N requests arrive together at the moment a popular key's TTL expires,
// all N miss, and all N rush to the DB. That is what is measured here.
const HOST = process.env.HOST ?? 'localhost';
const PORT = Number(process.env.PORT ?? 3000);
const USER_ID = 7;
const CONCURRENCY = 50;
// imitating an "expensive query" — otherwise there's no stampede window at all (explained below)
const QUERY_MS = 200;

// Important: Node's built-in fetch (undici) opens only a few connections per origin,
// so even 50 fetches sent with Promise.all actually go in steps of
// 5-6 — that is, not truly at once. Then the first batch's
// response lands in the cache and the stampede never happens.
// Hence our own agent here, with more maxSockets — so all 50 really go at once.
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
	// deleting the key = imitating the moment the TTL expires
	await invalidate(keys.tasksByUser(USER_ID));
	await post('/api/_stats/reset');
	// open the TCP connections beforehand, so connection setup is not on the
	// critical path during the burst
	await Promise.all(Array.from({ length: CONCURRENCY }, () => get('/api/_stats')));

	const path = `/api/tasks?userId=${USER_ID}&delay=${QUERY_MS}${singleFlight ? '&sf=1' : ''}`;
	const started = Date.now();
	// CONCURRENCY requests at exactly the same moment — this is the stampede
	await Promise.all(Array.from({ length: CONCURRENCY }, () => get(path)));
	const ms = Date.now() - started;

	return { dbQueries: await dbCount(), ms };
}

async function main(): Promise<void> {
	console.log(
		`\n  ${CONCURRENCY} requests at once, cache just emptied, DB query ~${QUERY_MS}ms:\n`
	);

	const naive = await burst(false);
	console.log(
		`  without single-flight : DB queries ${String(naive.dbQueries).padStart(3)}   (${naive.ms} ms)`
	);

	const guarded = await burst(true);
	console.log(
		`  with single-flight    : DB queries ${String(guarded.dbQueries).padStart(3)}   (${guarded.ms} ms)`
	);

	console.log(
		`\n  saved                 : ${naive.dbQueries - guarded.dbQueries} unnecessary DB queries\n`
	);

	agent.destroy();
	await redis.quit();
}

main().catch((error: unknown): void => {
	console.error('stampede demo failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
