import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { isBase62 } from './base62';
import {
	ClickBuffer,
	CODE_LENGTH,
	CodeGenerator,
	CountingSequence,
	type Link,
	type LinkStats,
	type LinkStore,
	MemoryLinkStore,
	RangeAllocator,
	resolve
} from './store';

export const ConfigSchema = z.object({
	PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
	SHORT_ORIGIN: z.string().url().default('http://localhost:3000'),
	BLOCK_SIZE: z.coerce.number().int().positive().default(1000),
	SECRET: z.coerce.number().int().default(20_261_004)
});
export type Config = z.infer<typeof ConfigSchema>;

const RESERVED = new Set(['api', 'admin', 'health', 'static', 'login', 'signup']);

const CreateLinkBody = z.object({
	url: z.string().trim().max(2048).url(),
	alias: z
		.string()
		.regex(/^[A-Za-z0-9_-]{4,32}$/)
		.optional(),
	expiresAt: z.string().datetime().optional()
});

const CodeParams = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/) });

type ErrorCode =
	| 'invalid_body'
	| 'unsupported_scheme'
	| 'self_redirect'
	| 'alias_reserved'
	| 'alias_taken'
	| 'expiry_in_past'
	| 'not_found'
	| 'expired'
	| 'disabled';

interface ApiError {
	error: { code: ErrorCode; message: string };
}

interface CreatedLink {
	code: string;
	shortUrl: string;
	url: string;
	expiresAt: string | null;
}

export interface Shortener {
	app: Express;
	store: LinkStore;
	sequence: CountingSequence;
	clicks: ClickBuffer;
}

const fail = (res: Response<ApiError>, status: number, code: ErrorCode, message: string): void => {
	res.status(status).json({ error: { code, message } });
};

export function createShortener(config: Config, now: () => number = Date.now): Shortener {
	const store = new MemoryLinkStore();
	const sequence = new CountingSequence();
	const generator = new CodeGenerator(
		new RangeAllocator(sequence, config.BLOCK_SIZE),
		config.SECRET
	);
	const clicks = new ClickBuffer();
	const shortHost = new URL(config.SHORT_ORIGIN).host;
	const app = express();
	app.disable('x-powered-by');
	app.use(express.json({ limit: '8kb' }));

	app.post(
		'/api/links',
		(
			req: Request<Record<string, never>, CreatedLink | ApiError, unknown>,
			res: Response<CreatedLink | ApiError>
		) => {
			const parsed = CreateLinkBody.safeParse(req.body);
			if (!parsed.success) {
				fail(
					res,
					400,
					'invalid_body',
					parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
				);
				return;
			}
			const { url, alias, expiresAt } = parsed.data;
			const target = new URL(url);
			if (target.protocol !== 'https:' && target.protocol !== 'http:') {
				fail(res, 400, 'unsupported_scheme', `${target.protocol} link নেওয়া হয় না`);
				return;
			}
			if (target.host === shortHost) {
				fail(res, 400, 'self_redirect', 'নিজের short link কে আবার ছোট করা যায় না (redirect loop)');
				return;
			}
			const expiry = expiresAt === undefined ? null : Date.parse(expiresAt);
			if (expiry !== null && expiry <= now()) {
				fail(res, 400, 'expiry_in_past', 'মেয়াদ ভবিষ্যতে হতে হবে');
				return;
			}
			if (
				alias !== undefined &&
				(RESERVED.has(alias.toLowerCase()) || (alias.length === CODE_LENGTH && isBase62(alias)))
			) {
				fail(
					res,
					400,
					'alias_reserved',
					`এই alias সংরক্ষিত, বা ${CODE_LENGTH} অক্ষরের তৈরি করা code এর জায়গায় পড়ে`
				);
				return;
			}
			const base: Omit<Link, 'code' | 'custom'> = {
				url: target.toString(),
				createdAt: now(),
				expiresAt: expiry,
				state: { kind: 'active' }
			};
			let code: string;
			if (alias !== undefined) {
				if (store.insert({ ...base, code: alias, custom: true }) === 'taken') {
					fail(res, 409, 'alias_taken', 'এই alias আগেই নেওয়া');
					return;
				}
				code = alias;
			} else {
				do code = generator.next();
				while (store.insert({ ...base, code, custom: false }) === 'taken');
			}
			res.status(201).json({
				code,
				shortUrl: `${config.SHORT_ORIGIN}/${code}`,
				url: base.url,
				expiresAt: expiry === null ? null : new Date(expiry).toISOString()
			});
		}
	);

	app.get(
		'/api/links/:code/stats',
		(req: Request<{ code: string }>, res: Response<LinkStats | ApiError>) => {
			const params = CodeParams.safeParse(req.params);
			if (!params.success || store.get(params.data.code) === undefined) {
				fail(res, 404, 'not_found', 'এই code এর কোনো link নেই');
				return;
			}
			res.json(clicks.stats(params.data.code));
		}
	);

	app.post(
		'/api/links/:code/disable',
		(req: Request<{ code: string }>, res: Response<ApiError>) => {
			const params = CodeParams.safeParse(req.params);
			if (!params.success || !store.disable(params.data.code, 'abuse report', now())) {
				fail(res, 404, 'not_found', 'এই code এর কোনো link নেই');
				return;
			}
			res.status(204).end();
		}
	);

	app.get('/:code', (req: Request<{ code: string }>, res: Response<ApiError>) => {
		const params = CodeParams.safeParse(req.params);
		const result = resolve(params.success ? store.get(params.data.code) : undefined, now());
		res.setHeader('Cache-Control', 'private, no-store');
		switch (result.kind) {
			case 'redirect':
				clicks.record(
					req.params.code,
					`${req.socket.remoteAddress ?? ''}|${req.get('user-agent') ?? ''}`,
					now()
				);
				res.redirect(302, result.url);
				return;
			case 'missing':
				fail(res, 404, 'not_found', 'এই code এর কোনো link নেই');
				return;
			case 'expired':
				fail(res, 410, 'expired', 'এই link এর মেয়াদ শেষ');
				return;
			case 'disabled':
				fail(res, 410, 'disabled', 'এই link বন্ধ করা হয়েছে');
				return;
		}
	});

	return { app, store, sequence, clicks };
}
