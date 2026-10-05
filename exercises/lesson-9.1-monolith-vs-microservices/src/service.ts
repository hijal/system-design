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

// One process — what it is, by ROLE:
//   monolith — the three modules in one process, the board built with direct function calls
//   tasks    — the board's route; calls users and comments over HTTP (CALLS = chatty or batched)
//   users, comments — their own module's HTTP API
// The parent (cluster.ts) provides ROLE and the other services' URLs in env; once the process is up it sends the port over IPC.

const env = z
	.object({
		ROLE: z.enum(['monolith', 'tasks', 'users', 'comments']),
		USERS_URL: z.string().default(''),
		COMMENTS_URL: z.string().default(''),
		CALLS: z.enum(['chatty', 'batched']).default('batched'),
		// 0 = no timeout (like the default fetch — waits forever)
		TIMEOUT_MS: z.coerce.number().int().nonnegative().default(0),
		// extra delay on every internal request — a separate machine's network instead of the same machine (experiment)
		NET_MS: z.coerce.number().nonnegative().default(0),
		EXPORT_MS: z.coerce.number().int().positive().default(300)
	})
	.parse(process.env);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Express 4 doesn't catch an async handler's rejection itself — catch it and pass it to next(), otherwise the process crashes
const handle =
	<P>(fn: (req: Request<P>, res: Response) => Promise<void>) =>
	(req: Request<P>, res: Response, next: NextFunction): void => {
		fn(req, res).catch(next);
	};

const idList = z
	.string()
	.transform((s) => s.split(',').map(Number))
	.pipe(z.array(z.number().int().positive()).max(500));

// ── a client for the other services — outside responses, so parsed with Zod (not a type assertion) ──
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
	// without comments the board still shows — just without the counts (when TIMEOUT_MS > 0; otherwise the error goes up)
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
		// two separate calls for every task — code as simple as an ORM's lazy load, N+1 over the network (Lesson 5.6)
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

	// batched: two calls, in parallel — all users at once, all counts at once
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
// pretending to be a separate machine's network: the internal API responds NET_MS late
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
// "export every comment" — heavy CPU work, in the process of the module it belongs to
if (env.ROLE === 'monolith' || env.ROLE === 'comments') {
	app.get('/export', (_req, res) => {
		res.json({ bytes: exportComments(env.EXPORT_MS) });
	});
}
// Error handler — Express recognizes it by its four parameters. If the response has already started, hand it to Express's own handler
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
	if (res.headersSent) {
		next(error);
		return;
	}
	res.status(502).json({ error: error instanceof Error ? error.message : 'unknown' });
});

const server = app.listen(0, '127.0.0.1', () => {
	const { port } = server.address() as AddressInfo; // after listen(0), address() is always an AddressInfo
	process.send?.({ type: 'ready', port });
});
server.keepAliveTimeout = 30_000;

// when the parent asks for the CPU accounting — this process's own user + system CPU time
process.on('message', (msg: unknown) => {
	if (msg === 'cpu') {
		const { user, system } = process.cpuUsage();
		process.send?.({ type: 'cpu', micros: user + system });
	}
});
