import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env, s3 } from './common';

// Lesson 8.2 §১.১ — TaskFlow এর API, আলাদা process এ (through-app.ts fork করে), যাতে তার memory আর
// event loop আলাদা করে মাপা যায়। Upload এর তিনটা পথ:
//   PUT /upload/buffer/:id — body পুরোটা memory তে (express.raw), তারপর S3 এ     ← 8.1 এর saveAttachment
//   PUT /upload/stream/:id — body টা সরাসরি S3 এর দিকে বইয়ে দেওয়া (stream)
//   POST /uploads          — শুধু একটা presigned URL দেয়; file app কে ছোঁয়ই না
// আর GET /api/ping — board এর মতো একটা সস্তা route, যার latency দিয়ে বুঝব app অন্যদের জন্য কেমন আছে।

export const messageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ready'), port: z.number() }),
	z.object({
		type: z.literal('stats'),
		peakRssMb: z.number(),
		baseRssMb: z.number(),
		maxOpenUploads: z.number(),
		bytesThroughApp: z.number(),
		loopDelayP99: z.number(),
		loopDelayMax: z.number()
	})
]);
type Message = z.infer<typeof messageSchema>;

const idSchema = z.string().regex(/^[a-z0-9-]+$/);
const presignSchema = z.object({
	size: z.number().int().positive(),
	contentType: z.string().min(1)
});

type Handler<P> = (req: Request<P>, res: Response) => Promise<void>;
const handle =
	<P>(fn: Handler<P>) =>
	(req: Request<P>, res: Response, next: NextFunction): void => {
		fn(req, res).catch(next);
	};

function main(): void {
	const app = express();
	let open = 0;
	let maxOpen = 0;
	let bytes = 0;
	const loop = monitorEventLoopDelay({ resolution: 1 });
	loop.enable();
	const baseRss = process.memoryUsage().rss;
	let peakRss = baseRss;
	setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 20).unref();

	// একটা upload request খোলা থাকা পর্যন্ত গোনা (Lesson 7.1 — খোলা request কী কী ধরে রাখে)
	const track = (req: Request, res: Response, next: NextFunction): void => {
		open++;
		maxOpen = Math.max(maxOpen, open);
		bytes += Number(req.headers['content-length'] ?? 0);
		res.on('close', () => open--);
		next();
	};

	app.put(
		'/upload/buffer/:id',
		track,
		express.raw({ type: '*/*', limit: '1gb' }),
		handle<{ id: string }>(async (req, res) => {
			const body = z.instanceof(Buffer).parse(req.body); // পুরো file এখন এই process এর memory তে
			await s3.send(
				new PutObjectCommand({
					Bucket: env.BUCKET,
					Key: `app/${idSchema.parse(req.params.id)}`,
					Body: body
				})
			);
			res.status(201).json({ ok: true });
		})
	);

	app.put(
		'/upload/stream/:id',
		track,
		handle<{ id: string }>(async (req, res) => {
			// req নিজেই একটা Readable stream — টুকরো আসে, টুকরো যায়; S3 এর stream PUT এ আকার আগে জানাতে হয়
			const length = z.coerce.number().int().positive().parse(req.headers['content-length']);
			await s3.send(
				new PutObjectCommand({
					Bucket: env.BUCKET,
					Key: `app/${idSchema.parse(req.params.id)}`,
					Body: req,
					ContentLength: length
				})
			);
			res.status(201).json({ ok: true });
		})
	);

	app.post(
		'/uploads',
		express.json(),
		handle(async (req, res) => {
			const input = presignSchema.parse(req.body);
			const key = `direct/${randomUUID()}`; // key server বানায় — client কখনো না (§১.২)
			const url = await getSignedUrl(
				s3,
				new PutObjectCommand({
					Bucket: env.BUCKET,
					Key: key,
					ContentType: input.contentType,
					ContentLength: input.size
				}),
				{ expiresIn: 300, signableHeaders: new Set(['content-type', 'content-length']) }
			);
			res.status(201).json({ key, url });
		})
	);

	app.get('/api/ping', (_req: Request, res: Response): void => {
		res.json({ ok: true });
	});

	const server = app.listen(0, () => {
		const { port } = server.address() as AddressInfo; // listen(0) এর পরে address() সবসময় AddressInfo
		const ready: Message = { type: 'ready', port };
		process.send?.(ready);
	});

	process.on('message', (raw: unknown) => {
		if (raw !== 'stats') return;
		const stats: Message = {
			type: 'stats',
			peakRssMb: peakRss / 1024 / 1024,
			baseRssMb: baseRss / 1024 / 1024,
			maxOpenUploads: maxOpen,
			bytesThroughApp: bytes,
			loopDelayP99: loop.percentile(99) / 1e6,
			loopDelayMax: loop.max / 1e6
		};
		process.send?.(stats);
	});
}

if (require.main === module) main();
