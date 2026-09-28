import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import {
	type Comment,
	commentSchema,
	commentsFor,
	type PageComment,
	task,
	type TaskPage,
	taskSchema,
	user,
	userSchema
} from './domain';
import { getJson, httpGet } from './http';
import { signInternal, verifyInternal, verifyJwt } from './token';

// একটা process — ROLE ধরে সে কী:
//   tasks, users, comments — TaskFlow এর service; পুরো object ফেরত দেয়
//   bff       — একটা frontend এর জন্য backend: page এর data জোড়া দেয়, আকৃতি ঠিক করে (SHAPE = web | mobile)
//   gateway   — সব বাইরের request এর একটা দরজা: token যাচাই, route, আর canary
//   files-old, files-new — thumbnail এর পুরনো পথ (monolith এর ভেতরে) আর নতুন service (9.1 এর strangler fig)
// Parent (cluster.ts) env দেয়, আর process তৈরি হলে IPC তে port পাঠায়।

const env = z
	.object({
		ROLE: z.enum(['tasks', 'users', 'comments', 'bff', 'gateway', 'files-old', 'files-new']),
		TASKS_URL: z.string().default(''),
		USERS_URL: z.string().default(''),
		COMMENTS_URL: z.string().default(''),
		FILES_OLD_URL: z.string().default(''),
		FILES_NEW_URL: z.string().default(''),
		SHAPE: z.enum(['web', 'mobile']).default('web'),
		// tasks service কীভাবে জানে request টা কার: trust = x-user-id header বিশ্বাস করে; signed = gateway এর sign যাচাই
		AUTH_MODE: z.enum(['trust', 'signed']).default('trust'),
		CANARY_PERCENT: z.coerce.number().min(0).max(100).default(0),
		// data center এর ভেতরে এক service থেকে আরেকটায় যাওয়ার দেরি — tasks/users/comments এর উত্তরে যোগ হয়
		NET_MS: z.coerce.number().nonnegative().default(0)
	})
	.parse(process.env);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const handle =
	<P>(fn: (req: Request<P>, res: Response) => Promise<void>) =>
	(req: Request<P>, res: Response, next: NextFunction): void => {
		fn(req, res).catch(next);
	};
const idParam = z.coerce.number().int().positive();
const idList = z
	.string()
	.transform((s) => s.split(',').map(Number))
	.pipe(z.array(z.number().int().positive()).max(500));

// অন্য service এর উত্তর — বাইরের data, তাই Zod দিয়ে parse
async function call<T>(url: string, schema: z.ZodType<T>): Promise<T> {
	return schema.parse(await getJson(url));
}

const app = express();
if (env.NET_MS > 0 && ['tasks', 'users', 'comments'].includes(env.ROLE))
	app.use((_req, _res, next) => void sleep(env.NET_MS).then(() => next()));

// ── tasks ──
if (env.ROLE === 'tasks') {
	app.get('/tasks/:id', (req, res) => {
		// কার request? Gateway এর পেছনের service — কিন্তু কীভাবে জানে header টা gateway ই বসিয়েছে?
		const raw = req.header('x-user-id') ?? '';
		const viewer: number | null =
			env.AUTH_MODE === 'trust'
				? /^\d+$/.test(raw)
					? Number(raw)
					: null
				: verifyInternal(req.header('x-internal-auth') ?? '');
		const t = task(idParam.parse(req.params.id));
		if (!t) {
			res.status(404).json({ error: 'NOT_FOUND' });
			return;
		}
		// board এর পথে (bff script) viewer লাগে না; gateway script এ লাগে
		if (req.query.requireViewer === '1' && viewer === null) {
			res.status(401).json({ error: 'UNAUTHENTICATED' });
			return;
		}
		res.json(req.query.requireViewer === '1' ? { taskId: t.id, viewer } : t);
	});
}

// ── users ──
if (env.ROLE === 'users') {
	app.get('/users/:id', (req, res) => {
		const u = user(idParam.parse(req.params.id));
		if (u) res.json(u);
		else res.status(404).json({ error: 'NOT_FOUND' });
	});
	app.get('/users', (req, res) => {
		res.json(
			idList
				.parse(req.query.ids)
				.map(user)
				.filter((u) => u !== null)
		);
	});
}

// ── comments ──
if (env.ROLE === 'comments') {
	app.get('/comments', (req, res) => {
		res.json(commentsFor(idParam.parse(req.query.taskId)));
	});
}

// ── bff: task detail page এর data, এক request এ ──
if (env.ROLE === 'bff') {
	app.get(
		'/pages/task/:id',
		handle<{ id: string }>(async (req, res) => {
			const id = idParam.parse(req.params.id);
			// ধাপ ১: task (তার পরেই জানা যায় assignee কে)
			const t = await call(`${env.TASKS_URL}/tasks/${id}`, taskSchema);
			// ধাপ ২: comment গুলো (তার পরেই জানা যায় author কারা)
			const all: Comment[] = await call(
				`${env.COMMENTS_URL}/comments?taskId=${id}`,
				z.array(commentSchema)
			);
			const shown = env.SHAPE === 'mobile' ? all.slice(-5) : all;
			// ধাপ ৩: assignee আর author, সব একবারে
			const ids = [...new Set([t.assigneeId, ...shown.map((c) => c.authorId)])].join(',');
			const people = await call(`${env.USERS_URL}/users?ids=${ids}`, z.array(userSchema));
			const byId = new Map(people.map((u) => [u.id, { name: u.name, avatar: u.avatar }]));
			const comments: PageComment[] = shown.map((c) => ({
				id: c.id,
				body: env.SHAPE === 'mobile' ? c.body.slice(0, 140) : c.body,
				at: c.createdAt,
				author: byId.get(c.authorId) ?? { name: 'unknown', avatar: '' }
			}));
			const page: TaskPage = {
				id: t.id,
				title: t.title,
				description: env.SHAPE === 'mobile' ? t.description.slice(0, 200) : t.description,
				status: t.status,
				dueAt: t.dueAt,
				assignee: byId.get(t.assigneeId) ?? null,
				comments,
				commentCount: all.length
			};
			res.json(page);
		})
	);
}

// ── files: thumbnail এর পুরনো আর নতুন পথ ──
if (env.ROLE === 'files-old' || env.ROLE === 'files-new') {
	app.get('/files/:id/thumbnail', (req, res) => {
		res.json({ fileId: idParam.parse(req.params.id), servedBy: env.ROLE });
	});
}

// ── gateway ──
if (env.ROLE === 'gateway') {
	// একই user সবসময় একই দিকে — canary তে একজনের অভিজ্ঞতা request ভেদে লাফায় না
	const bucket = (userId: number): number => (Math.imul(userId, 2654435761) >>> 0) % 100;

	app.use((req, res, next) => {
		req.headers['x-request-id'] ??= randomUUID();
		const token = (req.header('authorization') ?? '').replace(/^Bearer /, '');
		const claims = verifyJwt(token);
		if (!claims) {
			res.status(401).json({ error: 'UNAUTHENTICATED' });
			return;
		}
		res.locals.userId = claims.sub;
		next();
	});

	const forward = async (req: Request, res: Response, upstream: string): Promise<void> => {
		const userId = z.number().parse(res.locals.userId);
		// client এর পাঠানো পরিচয়ের header কখনো ভেতরে যাবে না — gateway নিজে বসায়
		const headers: Record<string, string> = {
			'x-user-id': String(userId),
			'x-request-id': String(req.headers['x-request-id'])
		};
		if (env.AUTH_MODE === 'signed') headers['x-internal-auth'] = signInternal(userId);
		const up = await httpGet(upstream, headers);
		res.status(up.status).type('application/json').send(up.body);
	};

	app.get(
		'/api/tasks/:id',
		handle<{ id: string }>(async (req, res) => {
			await forward(
				req,
				res,
				`${env.TASKS_URL}/tasks/${idParam.parse(req.params.id)}?requireViewer=1`
			);
		})
	);
	app.get(
		'/api/files/:id/thumbnail',
		handle<{ id: string }>(async (req, res) => {
			const userId = z.number().parse(res.locals.userId);
			const base = bucket(userId) < env.CANARY_PERCENT ? env.FILES_NEW_URL : env.FILES_OLD_URL;
			await forward(req, res, `${base}/files/${idParam.parse(req.params.id)}/thumbnail`);
		})
	);
}

// Error handler — Express চেনে চারটা parameter দেখে। উত্তর আগেই পাঠানো শুরু হলে Express এর নিজের handler এ দেওয়া
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
	if (res.headersSent) {
		next(error);
		return;
	}
	res.status(502).json({ error: error instanceof Error ? error.message : 'unknown' });
});

const server = app.listen(0, '127.0.0.1', () => {
	const { port } = server.address() as AddressInfo; // listen(0) এর পরে address() সবসময় AddressInfo
	process.send?.({ type: 'ready', port });
});
server.keepAliveTimeout = 30_000;

process.on('message', (msg: unknown) => {
	if (msg === 'cpu') {
		const { user: u, system } = process.cpuUsage();
		process.send?.({ type: 'cpu', micros: u + system });
	}
});
