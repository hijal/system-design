import express, { type Request, type Response } from 'express';
import { z } from 'zod';

// Lesson 7.1 §0 - a fake email provider (in place of SendGrid/SES), in a separate Node process.
//
//   POST /send         - "sends" an email: waits `latencyMs`, then 200 (429 over the limit)
//   POST /admin/mode   - change the latency (the scenario uses this to slow the provider down and fix it again)
//   GET  /admin/stats  - which tasks' emails were delivered
//
// The provider itself never breaks, it only gets slow - because most big real-world incidents come from "slow",
// not "dead" (the gray failure of Lesson 6.1). But like a real provider it has a limit:
// with more than MAX_CONCURRENT emails at once, the extras get an immediate 429 (rate limited).
// (A real provider's limit is usually "how many per second" - here it is "how many at once", for simplicity.)

const env = z
	.object({
		PORT: z.coerce.number().int().nonnegative().default(0),
		LATENCY_MS: z.coerce.number().int().nonnegative().default(150),
		MAX_CONCURRENT: z.coerce.number().int().positive().default(50)
	})
	.parse(process.env);

const sendSchema = z.object({
	to: z.string().min(1),
	taskId: z.number().int().positive()
});
const modeSchema = z.object({ latencyMs: z.number().int().nonnegative().max(120_000) });

let latencyMs = env.LATENCY_MS;
const deliveredTaskIds: number[] = [];
let inFlight = 0;
let peakInFlight = 0;
let rateLimited = 0;

const app = express();
app.use(express.json());

app.post('/send', (req: Request, res: Response): void => {
	const parsed = sendSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'VALIDATION_ERROR' });
		return;
	}
	if (inFlight >= env.MAX_CONCURRENT) {
		rateLimited++;
		res.status(429).json({ error: 'RATE_LIMITED' });
		return;
	}
	inFlight++;
	peakInFlight = Math.max(peakInFlight, inFlight);
	setTimeout(() => {
		inFlight--;
		deliveredTaskIds.push(parsed.data.taskId);
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
	res.json({ latencyMs });
});

app.get('/admin/stats', (_req: Request, res: Response): void => {
	res.json({ deliveredTaskIds, inFlight, peakInFlight, rateLimited, latencyMs });
});

const server = app.listen(env.PORT, '127.0.0.1', () => {
	const address = server.address();
	if (address && typeof address === 'object') process.send?.({ ready: true, port: address.port });
});
