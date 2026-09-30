import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import type { RateLimiter } from './limiters';

export type SharedStore = {
	check(
		key: string,
		now: number
	): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }>;
	calls(): number;
};

export type Instance = {
	id: string;
	url: string;
	handled: () => number;
	allowed: () => number;
	stop: () => Promise<void>;
};

function keyOf(req: Request): string {
	const header = req.header('x-user-id');
	return `ws-42:${header ?? 'anonymous'}`;
}

export function startInstance(
	id: string,
	port: number,
	limiter: RateLimiter | SharedStore,
	limit: number
): Promise<Instance> {
	const app = express();
	let handled = 0;
	let allowed = 0;

	const middleware = (req: Request, res: Response, next: NextFunction): void => {
		handled += 1;
		const now = performance.now();
		const key = keyOf(req);
		const decide =
			'calls' in limiter ? limiter.check(key, now) : Promise.resolve(limiter.check(key, now));
		decide
			.then((decision) => {
				res.setHeader('x-ratelimit-limit', String(limit));
				res.setHeader('x-ratelimit-remaining', String(decision.remaining));
				res.setHeader('x-served-by', id);
				if (decision.allowed) {
					allowed += 1;
					next();
					return;
				}
				res.setHeader('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)));
				res.status(429).json({ error: 'rate limit exceeded', retryAfterMs: decision.retryAfterMs });
			})
			.catch(() => {
				res.status(500).json({ error: 'limiter failed' });
			});
	};

	app.use(middleware);
	app.get('/tasks', (_req, res) => {
		res.json({ ok: true, servedBy: id });
	});

	return new Promise((resolve) => {
		const server: Server = app.listen(port, '127.0.0.1', () => {
			resolve({
				id,
				url: `http://127.0.0.1:${port}`,
				handled: () => handled,
				allowed: () => allowed,
				stop: () =>
					new Promise((done) => {
						server.closeAllConnections();
						server.close(() => done());
					})
			});
		});
	});
}
