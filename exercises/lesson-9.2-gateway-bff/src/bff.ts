import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { type Proc, start, stop } from './cluster';
import { commentSchema, type PageComment, type TaskPage, taskSchema, userSchema } from './domain';
import { DESKTOP, Link, MOBILE, type Profile } from './link';
import { ms, pad, percentile } from './random';

// Lesson 9.2 §1.3 — TaskFlow's "task detail" page: the task, the assignee, 20 comments and their authors.
//
// Two paths:
//   browser → services directly — the browser itself calls the three services, and assembles the page itself
//   browser → BFF — one request; the BFF calls the same three services inside the data center and builds the page's shape
// The browser's link is a model (RTT + shared bandwidth — link.ts); inside the data center every call gets NET_MS.

const cfg = z
	.object({
		PAGES: z.coerce.number().int().positive().default(40),
		NET_MS: z.coerce.number().nonnegative().default(1)
	})
	.parse(process.env);

// The browser assembling it itself — exactly what the (web) BFF does, but every step from the browser
async function directPage(link: Link, s: Services, id: number): Promise<TaskPage> {
	const t = taskSchema.parse(await link.get(`${s.tasks.url}/tasks/${id}`)); // step 1
	const [assigneeRaw, commentsRaw] = await Promise.all([
		link.get(`${s.users.url}/users/${t.assigneeId}`), // step 2 — in parallel
		link.get(`${s.comments.url}/comments?taskId=${id}`)
	]);
	const assignee = userSchema.parse(assigneeRaw);
	const all = z.array(commentSchema).parse(commentsRaw);
	const ids = [...new Set(all.map((c) => c.authorId))].join(',');
	const authors = z.array(userSchema).parse(await link.get(`${s.users.url}/users?ids=${ids}`)); // step 3
	const byId = new Map(
		[assignee, ...authors].map((u) => [u.id, { name: u.name, avatar: u.avatar }])
	);
	const comments: PageComment[] = all.map((c) => ({
		id: c.id,
		body: c.body,
		at: c.createdAt,
		author: byId.get(c.authorId) ?? { name: 'unknown', avatar: '' }
	}));
	return {
		id: t.id,
		title: t.title,
		description: t.description,
		status: t.status,
		dueAt: t.dueAt,
		assignee: byId.get(t.assigneeId) ?? null,
		comments,
		commentCount: all.length
	};
}

type Services = { tasks: Proc; users: Proc; comments: Proc; webBff: Proc; mobileBff: Proc };

type Row = {
	name: string;
	profile: Profile;
	levels: number;
	load: (link: Link, id: number) => Promise<unknown>;
};

async function measure(row: Row): Promise<void> {
	const times: number[] = [];
	let requests = 0;
	let bytes = 0;
	for (let i = 0; i < cfg.PAGES + 3; i++) {
		const link = new Link(row.profile); // every page load has its own link (one tab, one page)
		const t = performance.now();
		await row.load(link, (i % 200) + 1);
		const elapsed = performance.now() - t;
		if (i < 3) continue; // warm-up
		times.push(elapsed);
		requests += link.requests;
		bytes += link.bytes;
	}
	console.log(
		`   ${row.name.padEnd(30)} ${row.profile.name.padEnd(30)} ${pad(requests / cfg.PAGES, 8)} ${pad(row.levels, 6)} ${pad(`${(bytes / cfg.PAGES / 1024).toFixed(1)} KB`, 11)} ${pad(ms(percentile(times, 50)), 10)} ${pad(ms(percentile(times, 95)), 10)}`
	);
}

async function main(): Promise<void> {
	const internal = { NET_MS: String(cfg.NET_MS) };
	const tasks = await start('tasks', { ROLE: 'tasks', ...internal });
	const users = await start('users', { ROLE: 'users', ...internal });
	const comments = await start('comments', { ROLE: 'comments', ...internal });
	const urls = { TASKS_URL: tasks.url, USERS_URL: users.url, COMMENTS_URL: comments.url };
	const webBff = await start('web-bff', { ROLE: 'bff', SHAPE: 'web', ...urls });
	const mobileBff = await start('mobile-bff', { ROLE: 'bff', SHAPE: 'mobile', ...urls });
	const s: Services = { tasks, users, comments, webBff, mobileBff };
	try {
		// whether exactly the same page comes from both paths — otherwise the comparison means nothing
		const fast: Profile = { name: 'check', rttMs: 0, mbps: 10_000 };
		const direct = await directPage(new Link(fast), s, 7);
		const viaBff = await new Link(fast).get(`${webBff.url}/pages/task/7`);
		if (!isDeepStrictEqual(direct, viaBff)) throw new Error('direct and BFF pages differ');

		console.log(
			`\n── "Task detail" page: task + assignee + 20 comments + authors · ${cfg.NET_MS} ms per call inside the data center · ${cfg.PAGES} times ──`
		);
		console.log(
			`   ${'path'.padEnd(30)} ${'browser network'.padEnd(30)} requests  steps  to browser        p50        p95`
		);
		const rows: Row[] = [
			{
				name: 'browser → services, direct',
				profile: DESKTOP,
				levels: 3,
				load: (l, id) => directPage(l, s, id)
			},
			{
				name: 'browser → web BFF',
				profile: DESKTOP,
				levels: 1,
				load: (l, id) => l.get(`${webBff.url}/pages/task/${id}`)
			},
			{
				name: 'browser → services, direct',
				profile: MOBILE,
				levels: 3,
				load: (l, id) => directPage(l, s, id)
			},
			{
				name: 'browser → web BFF',
				profile: MOBILE,
				levels: 1,
				load: (l, id) => l.get(`${webBff.url}/pages/task/${id}`)
			},
			{
				name: 'app → mobile BFF',
				profile: MOBILE,
				levels: 1,
				load: (l, id) => l.get(`${mobileBff.url}/pages/task/${id}`)
			}
		];
		for (const row of rows) await measure(row);
		console.log(
			'\n   (the web BFF page and the page the browser assembles itself are exactly the same — verified. Mobile BFF: 200-character description, last 5 comments.)\n'
		);
	} finally {
		await Promise.all(Object.values(s).map(stop));
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
