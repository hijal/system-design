import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';

export interface Post {
	id: number;
	author: string;
	text: string;
	deleted: boolean;
}

interface FeedItem {
	id: number;
	author: string;
	text: string;
	via: 'push' | 'pull';
}

interface FeedPage {
	items: FeedItem[];
	nextCursor: number | null;
}

interface ErrorBody {
	error: string;
}

const UserId = z.string().regex(/^[a-z0-9_]{1,30}$/);
const PostBody = z.object({ text: z.string().min(1).max(500) });
const FeedQuery = z.object({
	limit: z.coerce.number().int().min(1).max(50).default(20),
	cursor: z.coerce.number().int().positive().optional(),
	offset: z.coerce.number().int().min(0).optional()
});

export class FeedStore {
	readonly following = new Map<string, Set<string>>();
	readonly followers = new Map<string, Set<string>>();
	readonly posts = new Map<number, Post>();
	readonly byAuthor = new Map<string, number[]>();
	readonly timelines = new Map<string, number[]>();
	readonly queue: { postId: number; follower: string }[] = [];
	readonly stats = { timelineWrites: 0, pullReads: 0, wouldPushAll: 0 };
	private nextId = 1;

	constructor(
		readonly celebrityThreshold: number,
		readonly timelineCap: number
	) {}

	private setOf(map: Map<string, Set<string>>, key: string): Set<string> {
		let set = map.get(key);
		if (set === undefined) {
			set = new Set();
			map.set(key, set);
		}
		return set;
	}

	isCelebrity(user: string): boolean {
		return (this.followers.get(user)?.size ?? 0) > this.celebrityThreshold;
	}

	follow(user: string, target: string): void {
		this.setOf(this.following, user).add(target);
		this.setOf(this.followers, target).add(user);
	}

	unfollow(user: string, target: string): void {
		this.following.get(user)?.delete(target);
		this.followers.get(target)?.delete(user);
	}

	private insert(user: string, postId: number): void {
		const timeline = this.timelines.get(user) ?? [];
		timeline.unshift(postId);
		if (timeline.length > this.timelineCap) timeline.length = this.timelineCap;
		this.timelines.set(user, timeline);
		this.stats.timelineWrites++;
	}

	publish(author: string, text: string): Post {
		const post: Post = { id: this.nextId++, author, text, deleted: false };
		this.posts.set(post.id, post);
		const own = this.byAuthor.get(author) ?? [];
		own.unshift(post.id);
		this.byAuthor.set(author, own);
		const followers = this.followers.get(author) ?? new Set<string>();
		this.stats.wouldPushAll += followers.size;
		if (!this.isCelebrity(author))
			for (const f of followers) this.queue.push({ postId: post.id, follower: f });
		return post;
	}

	drain(max = Number.POSITIVE_INFINITY): number {
		let done = 0;
		while (done < max && this.queue.length > 0) {
			const job = this.queue.shift();
			if (job === undefined) break;
			this.insert(job.follower, job.postId);
			done++;
		}
		return done;
	}

	remove(postId: number): boolean {
		const post = this.posts.get(postId);
		if (post === undefined) return false;
		post.deleted = true;
		return true;
	}

	feed(
		user: string,
		limit: number,
		cursor: number | undefined,
		offset: number | undefined
	): FeedPage {
		const follows = this.following.get(user) ?? new Set<string>();
		const candidates = new Map<number, 'push' | 'pull'>();
		for (const id of this.timelines.get(user) ?? []) candidates.set(id, 'push');
		for (const author of follows) {
			if (!this.isCelebrity(author)) continue;
			this.stats.pullReads++;
			for (const id of (this.byAuthor.get(author) ?? []).slice(0, this.timelineCap))
				candidates.set(id, 'pull');
		}
		const visible = [...candidates.entries()]
			.map(([id, via]) => ({ post: this.posts.get(id), via }))
			.filter(
				(c): c is { post: Post; via: 'push' | 'pull' } =>
					c.post !== undefined && !c.post.deleted && follows.has(c.post.author)
			)
			.sort((a, b) => b.post.id - a.post.id);
		const window =
			offset !== undefined
				? visible.slice(offset, offset + limit)
				: visible.filter((c) => cursor === undefined || c.post.id < cursor).slice(0, limit);
		const items = window.map(({ post, via }) => ({
			id: post.id,
			author: post.author,
			text: post.text,
			via
		}));
		const last = items[items.length - 1];
		return { items, nextCursor: items.length === limit && last !== undefined ? last.id : null };
	}
}

export function createFeedApp(store: FeedStore): Express {
	const app = express();
	app.use(express.json({ limit: '4kb' }));

	app.post(
		'/users/:id/follow/:target',
		(req: Request<{ id: string; target: string }>, res: Response<ErrorBody>) => {
			const user = UserId.safeParse(req.params.id);
			const target = UserId.safeParse(req.params.target);
			if (!user.success || !target.success || user.data === target.data) {
				res.status(400).json({ error: 'invalid_user' });
				return;
			}
			store.follow(user.data, target.data);
			res.status(204).end();
		}
	);

	app.delete(
		'/users/:id/follow/:target',
		(req: Request<{ id: string; target: string }>, res: Response<ErrorBody>) => {
			const user = UserId.safeParse(req.params.id);
			const target = UserId.safeParse(req.params.target);
			if (!user.success || !target.success) {
				res.status(400).json({ error: 'invalid_user' });
				return;
			}
			store.unfollow(user.data, target.data);
			res.status(204).end();
		}
	);

	app.post(
		'/users/:id/posts',
		(req: Request<{ id: string }>, res: Response<{ id: number } | ErrorBody>) => {
			const user = UserId.safeParse(req.params.id);
			const body = PostBody.safeParse(req.body);
			if (!user.success || !body.success) {
				res.status(400).json({ error: 'invalid_body' });
				return;
			}
			res.status(201).json({ id: store.publish(user.data, body.data.text).id });
		}
	);

	app.delete('/posts/:id', (req: Request<{ id: string }>, res: Response<ErrorBody>) => {
		const id = z.coerce.number().int().positive().safeParse(req.params.id);
		if (!id.success || !store.remove(id.data)) {
			res.status(404).json({ error: 'not_found' });
			return;
		}
		res.status(204).end();
	});

	app.get(
		'/users/:id/feed',
		(req: Request<{ id: string }>, res: Response<FeedPage | ErrorBody>) => {
			const user = UserId.safeParse(req.params.id);
			const query = FeedQuery.safeParse(req.query);
			if (!user.success || !query.success) {
				res.status(400).json({ error: 'invalid_query' });
				return;
			}
			res.json(store.feed(user.data, query.data.limit, query.data.cursor, query.data.offset));
		}
	);

	return app;
}
