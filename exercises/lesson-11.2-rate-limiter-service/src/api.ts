import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { LimiterClient } from './client';

const ApiKey = z.string().regex(/^[a-z0-9-]{3,40}$/);

declare module 'express-serve-static-core' {
	interface Request {
		apiKey?: string;
	}
}

type KeyOf = (req: Request) => string | undefined;

function limit(client: LimiterClient, keyOf: KeyOf) {
	return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
		const key = keyOf(req);
		if (key === undefined) {
			res.status(401).json({ error: 'missing_api_key' });
			return;
		}
		const decision = await client.check(key);
		switch (decision.kind) {
			case 'allow':
				res.setHeader('RateLimit-Remaining', String(decision.remaining));
				res.setHeader('X-RateLimit-Source', decision.source);
				next();
				return;
			case 'deny':
				res.setHeader('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))));
				res.setHeader('X-RateLimit-Source', decision.source);
				res.status(429).json({ error: 'rate_limited' });
				return;
			case 'unavailable':
				res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1_000)));
				res.status(503).json({ error: 'limiter_unavailable' });
				return;
		}
	};
}

export function createApi(client: LimiterClient): Express {
	const app = express();
	app.use((req: Request, _res: Response, next: NextFunction) => {
		const parsed = ApiKey.safeParse(req.get('x-api-key'));
		if (parsed.success) req.apiKey = parsed.data;
		next();
	});
	app.get(
		'/data',
		limit(client, (req) => (req.apiKey === undefined ? undefined : `api:${req.apiKey}`)),
		(_req: Request, res: Response) => {
			res.json({ ok: true });
		}
	);
	app.post(
		'/login',
		limit(client, (req) => `login:${req.socket.remoteAddress ?? 'unknown'}`),
		(_req: Request, res: Response) => {
			res.json({ ok: true });
		}
	);
	return app;
}
