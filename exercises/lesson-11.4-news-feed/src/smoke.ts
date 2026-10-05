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
	console.log(padEnd(step, 4) + padEnd(what, 60) + result);
};

async function main(): Promise<void> {
	const server: Server = createFeedApp(store).listen(0);
	await new Promise<void>((resolve) => server.once('listening', () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('could not get the port');
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
		page.items.length === 0 ? '(empty)' : page.items.map((i) => `${i.text}[${i.via}]`).join(' ');

	for (const fan of ['amy', 'bob', 'cat', 'dan']) await call('POST', `/users/${fan}/follow/star`);
	for (const fan of ['bob', 'cat']) await call('POST', `/users/${fan}/follow/alice`);

	heading(
		'one feed service: celebrity threshold 3 followers; star has 4 (pull), alice has 2 (push)'
	);
	console.log(padEnd('#', 4) + padEnd('step', 60) + 'result');

	await post('alice', 'a1');
	show(
		"alice posted a1; the fan-out queue hasn't run yet",
		`bob: ${describe(await feed('bob'))}; ${store.queue.length} in the queue`
	);
	store.drain();
	show(
		'the fan-out worker ran',
		`bob: ${describe(await feed('bob'))}; ${store.stats.timelineWrites} timeline writes`
	);

	const s1 = await post('star', 's1');
	show(
		'star posted s1 (4 followers → not pushed)',
		`${store.queue.length} in the queue; amy: ${describe(await feed('amy'))}`
	);
	show("bob's feed: push and pull merged, in id order", describe(await feed('bob')));

	for (let i = 2; i <= 7; i++) await post('alice', `a${i}`);
	store.drain();
	const page1 = await feed('cat', '?limit=3');
	show('cat, first page (limit 3)', describe(page1));
	await post('alice', 'a8');
	await post('alice', 'a9');
	store.drain();
	const byOffset = await feed('cat', '?limit=3&offset=3');
	const byCursor = await feed('cat', `?limit=3&cursor=${page1.nextCursor ?? 0}`);
	show('meanwhile a8, a9 arrived; second page ?offset=3', describe(byOffset));
	show(`second page ?cursor=${page1.nextCursor ?? 0}`, describe(byCursor));

	await call('DELETE', '/users/bob/follow/alice');
	show(
		'bob unfollows alice (the ids remain in his timeline)',
		`bob: ${describe(await feed('bob', '?limit=5'))}`
	);
	await call('DELETE', `/posts/${s1}`);
	show('s1 deleted', `amy: ${describe(await feed('amy'))}`);

	show(
		'the counts',
		`${store.stats.timelineWrites} timeline writes (${store.stats.wouldPushAll} if everyone were pushed), ${store.stats.pullReads} pull reads`
	);
	server.close();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
