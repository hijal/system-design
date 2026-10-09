import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env, s3 } from './common';

// Lesson 8.2 §1.1 - TaskFlow's API, in a separate process (forked by through-app.ts), so its memory and
// event loop can be measured separately. Three upload paths:
//   PUT /upload/buffer/:id - the whole body in memory (express.raw), then to S3     ← 8.1's saveAttachment
//   PUT /upload/stream/:id - the body streamed straight towards S3 (stream)
//   POST /uploads          - only hands out a presigned URL; the file never touches the app
// And GET /api/ping - a cheap route like the board, whose latency shows how the app is doing for everyone else.

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

	// counted while an upload request is open (Lesson 7.1 - what an open request holds on to)
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
			const body = z.instanceof(Buffer).parse(req.body); // the whole file is now in this process's memory
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
			// req itself is a Readable stream - pieces come in, pieces go out; S3's stream PUT needs the size up front
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
			const key = `direct/${randomUUID()}`; // the server builds the key - never the client (§1.2)
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
		const { port } = server.address() as AddressInfo; // after listen(0), address() is always an AddressInfo
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
