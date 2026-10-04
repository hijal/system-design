import { z } from 'zod';
import { ConfigSchema, createShortener } from './app';
import { env, heading, n, padEnd } from './util';

const BULK = env('BULK', 10_000);
const BLOCK_SIZE = env('BLOCK_SIZE', 1000);

let clock = Date.parse('2026-10-04T09:00:00Z');
const config = ConfigSchema.parse({ PORT: 0, SHORT_ORIGIN: 'https://sho.rt', BLOCK_SIZE });
const shortener = createShortener(config, () => clock);

const Created = z.object({ code: z.string(), shortUrl: z.string() });
const Failure = z.object({ error: z.object({ code: z.string() }) });
const Stats = z.object({ clicks: z.number(), uniqueVisitors: z.number() });

async function main(): Promise<void> {
	const server = shortener.app.listen(0);
	await new Promise<void>((done) => server.once('listening', done));
	const address = server.address();
	if (address === null || typeof address === 'string')
		throw new Error('server এর port পাওয়া গেল না');
	const { port } = address;
	const base = `http://127.0.0.1:${port}`;

	const post = async (path: string, body: unknown): Promise<{ status: number; json: unknown }> => {
		const res = await fetch(`${base}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const text = await res.text();
		return { status: res.status, json: text === '' ? null : JSON.parse(text) };
	};
	const get = async (
		path: string,
		agent = 'smoke'
	): Promise<{ status: number; location: string; json: unknown }> => {
		const res = await fetch(`${base}${path}`, {
			redirect: 'manual',
			headers: { 'user-agent': agent }
		});
		const text = await res.text();
		return {
			status: res.status,
			location: res.headers.get('location') ?? '',
			json: res.headers.get('content-type')?.includes('json') === true ? JSON.parse(text) : null
		};
	};
	const describe = (json: unknown, location = ''): string => {
		if (location !== '') return `Location: ${location}`;
		const created = Created.safeParse(json);
		if (created.success) return created.data.shortUrl;
		const failure = Failure.safeParse(json);
		if (failure.success) return failure.data.error.code;
		const stats = Stats.safeParse(json);
		if (stats.success) return `clicks ${stats.data.clicks}, unique ${stats.data.uniqueVisitors}`;
		return '';
	};
	const codeOf = (json: unknown): string => {
		const created = Created.safeParse(json);
		if (!created.success) throw new Error(`link তৈরি হয়নি: ${JSON.stringify(json)}`);
		return created.data.code;
	};

	heading('অংশ ক — API এর আচরণ (একটা আসল Express server, in-memory store, নকল ঘড়ি)');
	console.log(padEnd('#', 4) + padEnd('request', 54) + padEnd('status', 8) + 'ফল');
	let step = 0;
	const show = (request: string, status: number, detail: string): void => {
		step++;
		console.log(padEnd(step, 4) + padEnd(request, 54) + padEnd(status, 8) + detail);
	};

	const article = 'https://example.com/blog/system-design?ref=newsletter';
	const first = await post('/api/links', { url: article });
	show(`POST /api/links  ${article.slice(0, 30)}…`, first.status, describe(first.json));
	const again = await post('/api/links', { url: article });
	show('POST /api/links  (একই URL আবার)', again.status, describe(again.json));
	const a = codeOf(first.json);
	const b = codeOf(again.json);

	const hop = await get(`/${a}`);
	show(`GET /${a}`, hop.status, describe(hop.json, hop.location));
	const missing = await get('/zzzzzzz');
	show('GET /zzzzzzz', missing.status, describe(missing.json));

	for (const [label, body] of [
		['url: javascript:alert(1)', { url: 'javascript:alert(1)' }],
		['url: https://sho.rt/abc (নিজের domain)', { url: 'https://sho.rt/abc' }],
		['url: "not a url"', { url: 'not a url' }],
		['alias: launch-2026', { url: 'https://example.com/launch', alias: 'launch-2026' }],
		['alias: launch-2026 (আবার)', { url: 'https://example.com/other', alias: 'launch-2026' }],
		['alias: abcDEF1 (৭ অক্ষর base62)', { url: 'https://example.com/x', alias: 'abcDEF1' }],
		['alias: admin', { url: 'https://example.com/x', alias: 'admin' }]
	] as const) {
		const res = await post('/api/links', body);
		show(`POST /api/links  ${label}`, res.status, describe(res.json));
	}

	const expiring = await post('/api/links', {
		url: 'https://example.com/flash-sale',
		expiresAt: new Date(clock + 3_600_000).toISOString()
	});
	show('POST /api/links  expiresAt = এখন + ১ ঘণ্টা', expiring.status, describe(expiring.json));
	const e = codeOf(expiring.json);
	const beforeExpiry = await get(`/${e}`);
	show(`GET /${e}`, beforeExpiry.status, describe(beforeExpiry.json, beforeExpiry.location));
	clock += 2 * 3_600_000;
	const afterExpiry = await get(`/${e}`);
	show(`GET /${e}  (২ ঘণ্টা পরে)`, afterExpiry.status, describe(afterExpiry.json));

	const disabled = await post(`/api/links/${a}/disable`, {});
	show(`POST /api/links/${a}/disable`, disabled.status, 'abuse report → বন্ধ');
	const afterDisable = await get(`/${a}`);
	show(`GET /${a}`, afterDisable.status, describe(afterDisable.json));

	shortener.clicks.flush();
	for (const agent of ['phone', 'phone', 'laptop', 'tablet', 'laptop']) await get(`/${b}`, agent);
	const pending = shortener.clicks.pendingCount();
	const before = await get(`/api/links/${b}/stats`);
	show(
		`GET /api/links/${b}/stats  (৫ click, flush এর আগে)`,
		before.status,
		`${describe(before.json)}; buffer এ ${pending}`
	);
	shortener.clicks.flush();
	const after = await get(`/api/links/${b}/stats`);
	show(`GET /api/links/${b}/stats  (flush এর পরে)`, after.status, describe(after.json));

	heading(`অংশ খ — ${n(BULK)}টা link তৈরি, block size ${n(BLOCK_SIZE)}`);
	const callsBefore = shortener.sequence.calls;
	const codes = new Set<string>();
	const sample: string[] = [];
	for (let i = 0; i < BULK; i++) {
		const res = await post('/api/links', { url: `https://example.com/item/${i}` });
		const code = codeOf(res.json);
		codes.add(code);
		if (i < 6) sample.push(code);
	}
	console.log(`আলাদা code: ${n(codes.size)} / ${n(BULK)}`);
	console.log(`sequence (database) এ যেতে হলো: ${n(shortener.sequence.calls - callsBefore)} বার`);
	console.log(`পরপর তৈরি হওয়া code: ${sample.join(' ')}`);
	console.log(`store এ মোট link: ${n(shortener.store.size())}`);

	server.close();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
