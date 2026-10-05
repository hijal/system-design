import express, { type Request, type Response } from 'express';
import { z } from 'zod';

// Lesson 7.3 — a fake email provider (like Lesson 7.1's), in a separate Node process.
//
//   POST /send         — wait `latencyMs`, then 200; 503 in proportion to FAIL_RATE (a temporary failure)
//   POST /admin/mode   — change the latency and failRate
//   GET  /admin/stats  — how many times each key's email was delivered
//
// To the provider every email has a `key` (our job ID) — if the same key arrives twice it sends
// it twice, because it doesn't dedupe. The key is kept precisely to count duplicates.

const env = z
	.object({
		LATENCY_MS: z.coerce.number().int().nonnegative().default(150),
		FAIL_RATE: z.coerce.number().min(0).max(1).default(0)
	})
	.parse(process.env);

const sendSchema = z.object({ key: z.string().min(1), to: z.string().min(1) });
const modeSchema = z.object({
	latencyMs: z.number().int().nonnegative().max(120_000),
	failRate: z.number().min(0).max(1).optional()
});

let latencyMs = env.LATENCY_MS;
let failRate = env.FAIL_RATE;
let rejected = 0;
const deliveries = new Map<string, number>();

const app = express();
app.use(express.json());

app.post('/send', (req: Request, res: Response): void => {
	const parsed = sendSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'VALIDATION_ERROR' });
		return;
	}
	const { key } = parsed.data;
	setTimeout(() => {
		if (Math.random() < failRate) {
			rejected++;
			res.status(503).json({ error: 'TEMPORARILY_UNAVAILABLE' });
			return;
		}
		deliveries.set(key, (deliveries.get(key) ?? 0) + 1);
		res.json({ ok: true });
	}, latencyMs);
});

app.post('/admin/mode', (req: Request, res: Response): void => {
	const parsed = modeSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'VALIDATION_ERROR' });
		return;
	}
	latencyMs = parsed.data.latencyMs;
	if (parsed.data.failRate !== undefined) failRate = parsed.data.failRate;
	res.json({ latencyMs, failRate });
});

app.get('/admin/stats', (_req: Request, res: Response): void => {
	res.json({ deliveries: Object.fromEntries(deliveries), rejected });
});

const server = app.listen(0, '127.0.0.1', () => {
	const address = server.address();
	if (address && typeof address === 'object') process.send?.({ ready: true, port: address.port });
});
