import express, { type Request, type Response } from 'express';
import { z } from 'zod';

// Lesson 7.1 §০ — একটা নকল email provider (SendGrid/SES এর জায়গায়), আলাদা Node process এ।
//
//   POST /send         — একটা email "পাঠায়": `latencyMs` অপেক্ষা করে তারপর 200 (সীমা ছাড়ালে 429)
//   POST /admin/mode   — latency বদলানো (scenario এটা দিয়ে provider কে ধীর করে, আবার সারায়)
//   GET  /admin/stats  — কোন কোন task এর email পৌঁছেছে
//
// Provider নিজে ভাঙে না, শুধু ধীর হয় — কারণ বাস্তবের বেশিরভাগ বড় incident "ধীর" থেকে আসে,
// "মৃত" থেকে না (Lesson 6.1 এর gray failure)। তবে বাস্তবের provider এর মতো এর একটা সীমা আছে:
// একসাথে MAX_CONCURRENT এর বেশি email এলে বাড়তিগুলো সাথে সাথে 429 (rate limited)।
// (আসল provider এর সীমা সাধারণত "প্রতি সেকেন্ডে কয়টা" — এখানে সরলতার জন্য "একসাথে কয়টা"।)

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
