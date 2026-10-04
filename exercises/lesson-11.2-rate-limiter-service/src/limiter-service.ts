import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { TokenBucket } from './sim';

export const RuleSchema = z.object({
	prefix: z.string().min(1),
	rate: z.number().positive(),
	burst: z.number().positive(),
	failMode: z.enum(['open', 'closed', 'local'])
});
export type Rule = z.infer<typeof RuleSchema>;

const CheckBody = z.object({
	key: z.string().min(1).max(200),
	cost: z.number().int().positive().default(1)
});
const LeaseBody = z.object({
	key: z.string().min(1).max(200),
	want: z.number().int().positive().max(1_000)
});
const DelayBody = z.object({ ms: z.number().int().min(0).max(60_000) });

export const CheckResult = z.object({
	allowed: z.boolean(),
	limit: z.number(),
	remaining: z.number(),
	retryAfterMs: z.number()
});
export type CheckResult = z.infer<typeof CheckResult>;

export const LeaseResult = z.object({
	granted: z.number(),
	retryAfterMs: z.number(),
	ttlMs: z.number()
});
export type LeaseResult = z.infer<typeof LeaseResult>;

interface ErrorBody {
	error: string;
}

export interface LimiterService {
	app: Express;
	stats: { checks: number; leases: number };
}

export function ruleFor(rules: readonly Rule[], key: string): Rule | undefined {
	return rules.find((rule) => key.startsWith(rule.prefix));
}

export function createLimiterService(
	rules: readonly Rule[],
	now: () => number,
	leaseTtlMs = 1_000
): LimiterService {
	const buckets = new Map<string, TokenBucket>();
	const stats = { checks: 0, leases: 0 };
	let delayMs = 0;
	const bucketFor = (key: string): { rule: Rule; bucket: TokenBucket } | undefined => {
		const rule = ruleFor(rules, key);
		if (rule === undefined) return undefined;
		let bucket = buckets.get(key);
		if (bucket === undefined) {
			bucket = new TokenBucket(rule.rate, rule.burst, now());
			buckets.set(key, bucket);
		}
		return { rule, bucket };
	};
	const later = (run: () => void): void => {
		if (delayMs === 0) run();
		else setTimeout(run, delayMs);
	};

	const app = express();
	app.use(express.json({ limit: '2kb' }));

	app.post('/v1/check', (req: Request, res: Response<CheckResult | ErrorBody>) => {
		const body = CheckBody.safeParse(req.body);
		if (!body.success) {
			res.status(400).json({ error: 'invalid_body' });
			return;
		}
		const found = bucketFor(body.data.key);
		if (found === undefined) {
			res.status(404).json({ error: 'no_rule' });
			return;
		}
		stats.checks++;
		const t = now();
		const allowed =
			found.bucket.peek(t) >= body.data.cost &&
			found.bucket.take(t, body.data.cost) === body.data.cost;
		const result: CheckResult = {
			allowed,
			limit: found.rule.rate,
			remaining: Math.floor(found.bucket.peek(t)),
			retryAfterMs: allowed ? 0 : found.bucket.retryAfterMs(t)
		};
		later(() => res.json(result));
	});

	app.post('/v1/lease', (req: Request, res: Response<LeaseResult | ErrorBody>) => {
		const body = LeaseBody.safeParse(req.body);
		if (!body.success) {
			res.status(400).json({ error: 'invalid_body' });
			return;
		}
		const found = bucketFor(body.data.key);
		if (found === undefined) {
			res.status(404).json({ error: 'no_rule' });
			return;
		}
		stats.leases++;
		const t = now();
		const full = found.bucket.peek(t) >= body.data.want;
		const granted = full ? found.bucket.take(t, body.data.want) : 0;
		const retryAfterMs = full
			? 0
			: Math.ceil(((body.data.want - found.bucket.peek(t)) / found.rule.rate) * 1_000);
		later(() => res.json({ granted, retryAfterMs, ttlMs: leaseTtlMs }));
	});

	app.post('/admin/delay', (req: Request, res: Response<ErrorBody>) => {
		const body = DelayBody.safeParse(req.body);
		if (!body.success) {
			res.status(400).json({ error: 'invalid_body' });
			return;
		}
		delayMs = body.data.ms;
		res.status(204).end();
	});

	return { app, stats };
}
