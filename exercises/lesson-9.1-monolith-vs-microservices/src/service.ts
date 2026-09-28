import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import {
	type Board,
	type BoardCard,
	commentCount,
	exportComments,
	getUser,
	type User,
	userSchema,
	tasksForProject
} from './domain';

// একটা process — ROLE ধরে সে কী:
//   monolith — তিনটা module এক process এ, board বানাতে সরাসরি function call
//   tasks    — board এর route; users আর comments কে HTTP তে ডাকে (CALLS = chatty বা batched)
//   users, comments — নিজের module এর HTTP API
// Parent (cluster.ts) env এ ROLE আর অন্য service এর URL দেয়; process তৈরি হলে IPC তে port পাঠায়।

const env = z
	.object({
		ROLE: z.enum(['monolith', 'tasks', 'users', 'comments']),
		USERS_URL: z.string().default(''),
		COMMENTS_URL: z.string().default(''),
		CALLS: z.enum(['chatty', 'batched']).default('batched'),
		// 0 = কোনো timeout নেই (default fetch এর মতো — চিরকাল অপেক্ষা)
		TIMEOUT_MS: z.coerce.number().int().nonnegative().default(0),
		// প্রতিটা internal request এ বাড়তি দেরি — একই machine এর বদলে আলাদা machine এর network (experiment)
		NET_MS: z.coerce.number().nonnegative().default(0),
		EXPORT_MS: z.coerce.number().int().positive().default(300)
	})
	.parse(process.env);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Express 4 async handler এর rejection নিজে ধরে না — ধরে next() এ দেওয়া, নইলে process crash
const handle =
	<P>(fn: (req: Request<P>, res: Response) => Promise<void>) =>
	(req: Request<P>, res: Response, next: NextFunction): void => {
		fn(req, res).catch(next);
	};

const idList = z
	.string()
	.transform((s) => s.split(',').map(Number))
	.pipe(z.array(z.number().int().positive()).max(500));

// ── অন্য service এর client — বাইরের উত্তর, তাই Zod দিয়ে parse (type assertion না) ──
async function call<T>(url: string, schema: z.ZodType<T>): Promise<T> {
	const res = await fetch(
		url,
		env.TIMEOUT_MS > 0 ? { signal: AbortSignal.timeout(env.TIMEOUT_MS) } : {}
	);
	if (!res.ok) throw new Error(`${url} → ${res.status}`);
	return schema.parse(await res.json());
}
const countsSchema = z.record(z.string(), z.number());

async function remoteBoard(projectId: number): Promise<Board> {
	const tasks = tasksForProject(projectId);
	let degraded = false;
	// comments না পেলে board তবু দেখায় — শুধু সংখ্যা ছাড়া (TIMEOUT_MS > 0 হলে; নইলে error উপরে যায়)
	const soft = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
		if (env.TIMEOUT_MS === 0) return fn();
		try {
			return await fn();
		} catch {
			degraded = true;
			return fallback;
		}
	};

	if (env.CALLS === 'chatty') {
		// প্রতিটা task এর জন্য আলাদা দুটো call — ORM এর lazy load এর মতো সরল code, network এ N+1 (Lesson 5.6)
		const cards = await Promise.all(
			tasks.map(async (t): Promise<BoardCard> => {
				const [assignee, comments] = await Promise.all([
					call(`${env.USERS_URL}/users/${t.assigneeId}`, userSchema),
					soft(() => call(`${env.COMMENTS_URL}/comments/count/${t.id}`, z.number()), null)
				]);
				return { id: t.id, title: t.title, assignee, comments };
			})
		);
		return { projectId, cards, degraded };
	}

	// batched: দুটো call, একসাথে — সব user একবারে, সব গোনা একবারে
	const ids = [...new Set(tasks.map((t) => t.assigneeId))].join(',');
	const taskIds = tasks.map((t) => t.id).join(',');
	const [userList, counts] = await Promise.all([
		call(`${env.USERS_URL}/users?ids=${ids}`, z.array(userSchema)),
		soft<Record<string, number> | null>(
			() => call(`${env.COMMENTS_URL}/comments/counts?taskIds=${taskIds}`, countsSchema),
			null
		)
	]);
	const byId = new Map<number, User>(userList.map((u) => [u.id, u]));
	const cards = tasks.map((t) => ({
		id: t.id,
		title: t.title,
		assignee: byId.get(t.assigneeId) ?? null,
		comments: counts ? (counts[String(t.id)] ?? 0) : null
	}));
	return { projectId, cards, degraded };
}

function localBoard(projectId: number): Board {
	const cards = tasksForProject(projectId).map((t) => ({
		id: t.id,
		title: t.title,
		assignee: getUser(t.assigneeId),
		comments: commentCount(t.id)
	}));
	return { projectId, cards, degraded: false };
}

const app = express();
// আলাদা machine এর network এর ভান: internal API এর উত্তর NET_MS দেরিতে
if (env.NET_MS > 0 && (env.ROLE === 'users' || env.ROLE === 'comments'))
	app.use((_req, _res, next) => void sleep(env.NET_MS).then(() => next()));

if (env.ROLE === 'monolith' || env.ROLE === 'tasks') {
	app.get(
		'/board/:projectId',
		handle<{ projectId: string }>(async (req, res) => {
			const projectId = z.coerce.number().int().positive().parse(req.params.projectId);
			res.json(env.ROLE === 'monolith' ? localBoard(projectId) : await remoteBoard(projectId));
		})
	);
}
if (env.ROLE === 'users') {
	app.get('/users/:id', (req, res) => {
		const user = getUser(Number(req.params.id));
		if (user) res.json(user);
		else res.status(404).json({ error: 'NOT_FOUND' });
	});
	app.get('/users', (req, res) => {
		const ids = idList.parse(req.query.ids);
		res.json(ids.map(getUser).filter((u) => u !== null));
	});
}
if (env.ROLE === 'comments') {
	app.get('/comments/count/:taskId', (req, res) => {
		res.json(commentCount(Number(req.params.taskId)));
	});
	app.get('/comments/counts', (req, res) => {
		const ids = idList.parse(req.query.taskIds);
		res.json(Object.fromEntries(ids.map((id) => [String(id), commentCount(id)])));
	});
}
// "সব comment এর export" — CPU এর ভারী কাজ, যে module এর, সেই process এ
if (env.ROLE === 'monolith' || env.ROLE === 'comments') {
	app.get('/export', (_req, res) => {
		res.json({ bytes: exportComments(env.EXPORT_MS) });
	});
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

// parent CPU এর হিসাব চাইলে — এই process এর নিজের user + system CPU সময়
process.on('message', (msg: unknown) => {
	if (msg === 'cpu') {
		const { user, system } = process.cpuUsage();
		process.send?.({ type: 'cpu', micros: user + system });
	}
});
