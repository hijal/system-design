import express, { type Request, type Response } from 'express';
import { z } from 'zod';

// Lesson 6.1 §১.৫–১.৬ — তিনটা ছোট service, সরলতার জন্য একটাই Express process এ:
//
//   /lock    — lock service: একসাথে একজনকেই lease দেয়; প্রতিবার নতুন holder এ token বাড়ে
//   /cursor  — shared storage: reminder job এর cursor ("পরের কোন batch পাঠাতে হবে")
//   /email   — email provider: কোন batch এর reminder কে পাঠাল, তার খাতা
//
// fencing = true হলে storage প্রতিটা লেখার token যাচাই করে: এ পর্যন্ত দেখা সবচেয়ে বড় token এর
// চেয়ে ছোট token এর লেখা প্রত্যাখ্যান। Email provider কোনো token দেখে না — বাস্তবের মতোই।

export type ServiceEvent =
	| { kind: 'lease-granted'; at: number; node: string; token: number }
	| { kind: 'email'; at: number; node: string; batch: number; duplicate: boolean }
	| { kind: 'cursor-write'; at: number; node: string; token: number; from: number; to: number }
	| { kind: 'cursor-rejected'; at: number; node: string; token: number; highest: number };

// Lease এর অবস্থা discriminated union দিয়ে — "holder আছে কিন্তু expiresAt নেই" জাতীয় অসম্ভব অবস্থা
// type এই বাদ পড়ে যায়
type LockState =
	{ status: 'free' } | { status: 'held'; holder: string; token: number; expiresAt: number };

const acquireSchema = z.object({ node: z.string().min(1) });
const cursorWriteSchema = z.object({
	node: z.string().min(1),
	token: z.number().int().positive(),
	value: z.number().int().nonnegative()
});
const emailSchema = z.object({ node: z.string().min(1), batch: z.number().int().nonnegative() });

export interface Services {
	app: express.Express;
	events: ServiceEvent[];
	emailsSent: Map<number, string[]>;
	finalCursor: () => number;
}

export function createServices(fencing: boolean, start: number, leaseMs: number): Services {
	const app = express();
	app.use(express.json());
	const events: ServiceEvent[] = [];
	const emailsSent = new Map<number, string[]>();
	const now = (): number => Date.now() - start;

	let lock: LockState = { status: 'free' };
	let tokenCounter = 0;
	let cursor = 0;
	let highestToken = 0;

	function badRequest(res: Response, error: z.ZodError): void {
		res.status(400).json({ error: 'VALIDATION_ERROR', details: error.flatten() });
	}

	// Acquire আর renew একই endpoint: holder নিজে চাইলে মেয়াদ বাড়ে (token একই থাকে);
	// অন্য কেউ চাইলে পায় শুধু যদি lease খালি বা মেয়াদোত্তীর্ণ — lock service এর নিজের ঘড়িতে
	app.post('/lock/acquire', (req: Request, res: Response): void => {
		const parsed = acquireSchema.safeParse(req.body);
		if (!parsed.success) return badRequest(res, parsed.error);
		const { node } = parsed.data;
		const t = Date.now();
		if (lock.status === 'held' && lock.holder !== node && lock.expiresAt > t) {
			res.json({ granted: false, holder: lock.holder });
			return;
		}
		if (lock.status === 'free' || lock.holder !== node) {
			tokenCounter += 1;
			lock = { status: 'held', holder: node, token: tokenCounter, expiresAt: t + leaseMs };
			events.push({ kind: 'lease-granted', at: now(), node, token: tokenCounter });
		} else {
			lock = { ...lock, expiresAt: t + leaseMs };
		}
		res.json({ granted: true, token: lock.token, ttlMs: leaseMs });
	});

	app.get('/cursor', (_req: Request, res: Response): void => {
		res.json({ cursor });
	});

	app.put('/cursor', (req: Request, res: Response): void => {
		const parsed = cursorWriteSchema.safeParse(req.body);
		if (!parsed.success) return badRequest(res, parsed.error);
		const { node, token, value } = parsed.data;
		if (fencing && token < highestToken) {
			events.push({ kind: 'cursor-rejected', at: now(), node, token, highest: highestToken });
			res.status(409).json({ error: 'STALE_TOKEN', highest: highestToken });
			return;
		}
		highestToken = Math.max(highestToken, token);
		events.push({ kind: 'cursor-write', at: now(), node, token, from: cursor, to: value });
		cursor = value;
		res.json({ cursor });
	});

	app.post('/email', (req: Request, res: Response): void => {
		const parsed = emailSchema.safeParse(req.body);
		if (!parsed.success) return badRequest(res, parsed.error);
		const { node, batch } = parsed.data;
		const senders = emailsSent.get(batch) ?? [];
		senders.push(node);
		emailsSent.set(batch, senders);
		events.push({ kind: 'email', at: now(), node, batch, duplicate: senders.length > 1 });
		res.json({ ok: true });
	});

	return { app, events, emailsSent, finalCursor: () => cursor };
}
