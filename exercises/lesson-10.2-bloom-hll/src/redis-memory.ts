import Redis from 'ioredis';
import { heading, pct, row } from './random';

const USERS = Number(process.env.USERS ?? 1_000_000);
const PROBES = Number(process.env.PROBES ?? 100_000);
const CHUNK = 10_000;
const redis = new Redis({ port: Number(process.env.REDIS_PORT ?? 6383), lazyConnect: true });

function asNumber(value: unknown): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)))
		return Number(value);
	throw new Error(`expected a number from Redis, got ${JSON.stringify(value)}`);
}

function asNumbers(value: unknown): number[] {
	if (!Array.isArray(value)) throw new Error('expected an array from Redis');
	return value.map(asNumber);
}

const ids = (prefix: string, from: number, to: number): string[] =>
	Array.from({ length: to - from }, (_, i) => `${prefix}:${from + i}`);

async function inChunks(
	total: number,
	prefix: string,
	send: (batch: string[]) => Promise<unknown>
): Promise<void> {
	for (let from = 0; from < total; from += CHUNK)
		await send(ids(prefix, from, Math.min(total, from + CHUNK)));
}

async function memory(key: string): Promise<number> {
	return asNumber(await redis.call('MEMORY', 'USAGE', key, 'SAMPLES', '0'));
}

async function falsePositives(key: string, total: number): Promise<number> {
	let hits = 0;
	for (let from = 0; from < total; from += CHUNK) {
		const batch = ids('never', from, Math.min(total, from + CHUNK));
		hits += asNumbers(await redis.call('BF.MEXISTS', key, ...batch)).filter((v) => v === 1).length;
	}
	return hits;
}

const size = (bytes: number): string =>
	bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(2)} MB`
		: bytes >= 1024
			? `${(bytes / 1024).toFixed(1)} KB`
			: `${bytes} B`;

async function threeWays(): Promise<void> {
	heading(
		`A. ${USERS.toLocaleString('en-US')} distinct users in Redis ${await version()} - stored three ways`
	);
	await inChunks(USERS, 'user', (batch) => redis.sadd('uniq:set', ...batch));
	await inChunks(USERS, 'user', (batch) => redis.pfadd('uniq:hll', ...batch));
	await redis.call('BF.RESERVE', 'uniq:bf', '0.01', String(USERS));
	await inChunks(USERS, 'user', (batch) => redis.call('BF.MADD', 'uniq:bf', ...batch));

	const exact = await redis.scard('uniq:set');
	const estimate = await redis.pfcount('uniq:hll');
	const bfWrong = await falsePositives('uniq:bf', PROBES);
	console.log(
		row([
			['structure', 26],
			['MEMORY USAGE', 15],
			['what it can tell', 34]
		])
	);
	const lines: [string, number, string][] = [
		['SET (SADD)', await memory('uniq:set'), `exactly ${exact.toLocaleString('en-US')}, and who`],
		[
			'HyperLogLog (PFADD)',
			await memory('uniq:hll'),
			`~${estimate.toLocaleString('en-US')} (${pct(estimate - USERS, USERS, 2)} off), not who`
		],
		[
			'Bloom (BF.RESERVE 0.01)',
			await memory('uniq:bf'),
			`"is it there?" - ${pct(bfWrong, PROBES, 2)} wrong "yes"`
		]
	];
	for (const [label, bytes, answer] of lines)
		console.log(
			row([
				[label, 26],
				[size(bytes), 15],
				[answer, 34]
			])
		);
}

async function small(): Promise<void> {
	heading("B. At small sizes - today's viewers of one board (50)");
	await redis.sadd('board:set', ...ids('user', 0, 50));
	await redis.pfadd('board:hll', ...ids('user', 0, 50));
	const encoding = await redis.call('OBJECT', 'ENCODING', 'board:set');
	console.log(
		row([
			['structure', 26],
			['MEMORY USAGE', 15],
			['answer', 12]
		])
	);
	console.log(
		row([
			[`SET (${String(encoding)})`, 26],
			[size(await memory('board:set')), 15],
			[await redis.scard('board:set'), 12]
		])
	);
	console.log(
		row([
			['HyperLogLog (sparse)', 26],
			[size(await memory('board:hll')), 15],
			[await redis.pfcount('board:hll'), 12]
		])
	);
	await redis.pfadd('board:hll', ...ids('user', 50, 5_000));
	console.log(
		row([
			['HyperLogLog, at 5,000', 26],
			[size(await memory('board:hll')), 15],
			[await redis.pfcount('board:hll'), 12]
		])
	);
}

async function overfill(): Promise<void> {
	const capacity = Math.round(USERS / 4);
	heading(
		`C. Inserting ${(capacity * 3).toLocaleString('en-US')} into a Redis Bloom built for ${capacity.toLocaleString('en-US')} - default vs NONSCALING`
	);
	await redis.call('BF.RESERVE', 'grow:bf', '0.01', String(capacity));
	await redis.call('BF.RESERVE', 'fixed:bf', '0.01', String(capacity), 'NONSCALING');
	let rejected = 0;
	for (let from = 0; from < capacity * 3; from += CHUNK) {
		const batch = ids('user', from, Math.min(capacity * 3, from + CHUNK));
		await redis.call('BF.MADD', 'grow:bf', ...batch);
		const reply = await redis.call('BF.MADD', 'fixed:bf', ...batch);
		const accepted = Array.isArray(reply) ? reply.filter((v) => typeof v === 'number').length : 0;
		rejected += batch.length - accepted;
	}
	console.log(
		row([
			['filter', 16],
			['MEMORY USAGE', 15],
			['inner filters', 15],
			['measured FP rate', 22],
			['inserted → "no"', 19]
		])
	);
	for (const key of ['grow:bf', 'fixed:bf']) {
		let missing = 0;
		for (let from = 0; from < capacity * 3; from += CHUNK) {
			const batch = ids('user', from, Math.min(capacity * 3, from + CHUNK));
			missing += asNumbers(await redis.call('BF.MEXISTS', key, ...batch)).filter(
				(v) => v === 0
			).length;
		}
		const info = await redis.call('BF.INFO', key, 'FILTERS');
		const filters = Array.isArray(info) ? asNumber(info[0]) : asNumber(info);
		console.log(
			row([
				[key === 'grow:bf' ? 'default' : 'NONSCALING', 16],
				[size(await memory(key)), 15],
				[filters, 15],
				[pct(await falsePositives(key, PROBES), PROBES, 2), 22],
				[missing.toLocaleString('en-US'), 19]
			])
		);
	}
	console.log(
		`   NONSCALING: BF.MADD's reply says "non scaling filter is full" - ${rejected.toLocaleString('en-US')} names not inserted, and no exception`
	);
}

async function version(): Promise<string> {
	const info = await redis.info('server');
	return /redis_version:(\S+)/.exec(info)?.[1] ?? 'unknown';
}

async function main(): Promise<void> {
	await redis.connect();
	await redis.flushall();
	await threeWays();
	await small();
	await overfill();
	await redis.flushall();
	await redis.quit();
}

main().catch(async (error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	redis.disconnect();
	process.exitCode = 1;
});
