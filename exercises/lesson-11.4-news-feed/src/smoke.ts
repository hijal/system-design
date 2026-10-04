import type { Server } from 'node:http';
import { z } from 'zod';
import { createFeedApp, FeedStore } from './feed';
import { heading, padEnd } from './util';

const Page = z.object({
	items: z.array(
		z.object({
			id: z.number(),
			author: z.string(),
			text: z.string(),
			via: z.enum(['push', 'pull'])
		})
	),
	nextCursor: z.number().nullable()
});
type Page = z.infer<typeof Page>;
const Created = z.object({ id: z.number() });

const store = new FeedStore(3, 800);

let step = 0;
const show = (what: string, result: string): void => {
	step++;
	console.log(padEnd(step, 4) + padEnd(what, 52) + result);
};

async function main(): Promise<void> {
	const server: Server = createFeedApp(store).listen(0);
	await new Promise<void>((resolve) => server.once('listening', () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('port পাওয়া গেল না');
	const base = `http://127.0.0.1:${address.port}`;

	const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
		const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
		if (body !== undefined) init.body = JSON.stringify(body);
		const res = await fetch(`${base}${path}`, init);
		const text = await res.text();
		return text === '' ? null : JSON.parse(text);
	};
	const post = async (user: string, text: string): Promise<number> =>
		Created.parse(await call('POST', `/users/${user}/posts`, { text })).id;
	const feed = async (user: string, query = ''): Promise<Page> =>
		Page.parse(await call('GET', `/users/${user}/feed${query}`));
	const describe = (page: Page): string =>
		page.items.length === 0 ? '(খালি)' : page.items.map((i) => `${i.text}[${i.via}]`).join(' ');

	for (const fan of ['amy', 'bob', 'cat', 'dan']) await call('POST', `/users/${fan}/follow/star`);
	for (const fan of ['bob', 'cat']) await call('POST', `/users/${fan}/follow/alice`);

	heading(
		'একটা feed service: celebrity এর সীমা ৩ follower; star এর ৪ জন (pull), alice এর ২ জন (push)'
	);
	console.log(padEnd('#', 4) + padEnd('ধাপ', 52) + 'ফল');

	await post('alice', 'a1');
	show(
		'alice post করল a1; fan-out এর queue এখনও চলেনি',
		`bob: ${describe(await feed('bob'))}; queue এ ${store.queue.length}টা`
	);
	store.drain();
	show(
		'fan-out worker চলল',
		`bob: ${describe(await feed('bob'))}; timeline লেখা ${store.stats.timelineWrites}`
	);

	const s1 = await post('star', 's1');
	show(
		'star post করল s1 (৪ follower → push হয় না)',
		`queue এ ${store.queue.length}টা; amy: ${describe(await feed('amy'))}`
	);
	show('bob এর feed: push আর pull মিশিয়ে, id এর ক্রমে', describe(await feed('bob')));

	for (let i = 2; i <= 7; i++) await post('alice', `a${i}`);
	store.drain();
	const page1 = await feed('cat', '?limit=3');
	show('cat, প্রথম page (limit 3)', describe(page1));
	await post('alice', 'a8');
	await post('alice', 'a9');
	store.drain();
	const byOffset = await feed('cat', '?limit=3&offset=3');
	const byCursor = await feed('cat', `?limit=3&cursor=${page1.nextCursor ?? 0}`);
	show('এর মধ্যে a8, a9 এলো; দ্বিতীয় page ?offset=3', describe(byOffset));
	show(`দ্বিতীয় page ?cursor=${page1.nextCursor ?? 0}`, describe(byCursor));

	await call('DELETE', '/users/bob/follow/alice');
	show(
		'bob alice কে unfollow (timeline এ id গুলো রয়ে গেছে)',
		`bob: ${describe(await feed('bob', '?limit=5'))}`
	);
	await call('DELETE', `/posts/${s1}`);
	show('s1 মুছে ফেলা হলো', `amy: ${describe(await feed('amy'))}`);

	show(
		'হিসাব',
		`timeline লেখা ${store.stats.timelineWrites} (সবাইকে push হলে ${store.stats.wouldPushAll}), pull এ পড়া ${store.stats.pullReads}`
	);
	server.close();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
