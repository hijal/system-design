import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { LADDER } from './ladder';

export const SEGMENT_S = 4;

export type VideoStatus =
	| { kind: 'uploaded' }
	| { kind: 'processing'; done: number; total: number }
	| { kind: 'playable'; done: number; total: number }
	| { kind: 'ready' };

interface Video {
	id: number;
	title: string;
	durationS: number;
	segments: number;
	status: VideoStatus;
}

interface Job {
	video: number;
	rendition: number;
	segment: number;
}

const CreateVideo = z.object({
	title: z.string().min(1).max(200),
	durationS: z.number().int().min(1).max(36_000)
});

export class VodService {
	readonly videos = new Map<number, Video>();
	readonly segments = new Map<string, Buffer>();
	readonly queue: Job[] = [];
	readonly failNext = new Set<string>();
	readonly stats = { jobsRun: 0, failures: 0, writes: 0, skippedDuplicate: 0 };
	private nextId = 1;

	create(title: string, durationS: number): Video {
		const video: Video = {
			id: this.nextId++,
			title,
			durationS,
			segments: Math.ceil(durationS / SEGMENT_S),
			status: { kind: 'uploaded' }
		};
		this.videos.set(video.id, video);
		const order = [1, 0, 2, 3, 4];
		for (const rendition of order)
			for (let segment = 0; segment < video.segments; segment++)
				this.queue.push({ video: video.id, rendition, segment });
		video.status = { kind: 'processing', done: 0, total: video.segments * LADDER.length };
		return video;
	}

	static key(job: Job): string {
		return `${job.video}/${LADDER[job.rendition]?.name ?? '?'}/${job.segment}`;
	}

	complete(video: Video, rendition: number): boolean {
		for (let s = 0; s < video.segments; s++)
			if (!this.segments.has(VodService.key({ video: video.id, rendition, segment: s })))
				return false;
		return true;
	}

	available(video: Video): number[] {
		return LADDER.map((_, i) => i).filter((i) => this.complete(video, i));
	}

	work(budget: number): number {
		let ran = 0;
		while (ran < budget && this.queue.length > 0) {
			const job = this.queue.shift();
			if (job === undefined) break;
			ran++;
			this.stats.jobsRun++;
			const key = VodService.key(job);
			if (this.failNext.delete(key)) {
				this.stats.failures++;
				this.queue.push(job);
				continue;
			}
			if (this.segments.has(key)) {
				this.stats.skippedDuplicate++;
				continue;
			}
			const rendition = LADDER[job.rendition];
			if (rendition === undefined) continue;
			this.segments.set(
				key,
				Buffer.alloc(Math.round((rendition.mbps * SEGMENT_S * 1_000) / 8), job.rendition)
			);
			this.stats.writes++;
			this.refresh(job.video);
		}
		return ran;
	}

	redeliver(job: Job): void {
		this.queue.push(job);
	}

	private refresh(id: number): void {
		const video = this.videos.get(id);
		if (video === undefined) return;
		const ready = this.available(video);
		const done = [...this.segments.keys()].filter((k) => k.startsWith(`${id}/`)).length;
		const total = video.segments * LADDER.length;
		if (ready.length === LADDER.length) video.status = { kind: 'ready' };
		else if (ready.includes(0) && ready.includes(1))
			video.status = { kind: 'playable', done, total };
		else video.status = { kind: 'processing', done, total };
	}

	master(video: Video): string {
		const lines = ['#EXTM3U'];
		for (const i of this.available(video)) {
			const r = LADDER[i];
			if (r === undefined) continue;
			lines.push(
				`#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(r.mbps * 1_000_000)},RESOLUTION=${Math.round((r.height * 16) / 9)}x${r.height}`,
				`${r.name}/index.m3u8`
			);
		}
		return lines.join('\n');
	}

	media(video: Video): string {
		const lines = ['#EXTM3U', `#EXT-X-TARGETDURATION:${SEGMENT_S}`, '#EXT-X-PLAYLIST-TYPE:VOD'];
		for (let s = 0; s < video.segments; s++) {
			const last = s === video.segments - 1 ? video.durationS - s * SEGMENT_S : SEGMENT_S;
			lines.push(`#EXTINF:${last.toFixed(1)},`, `${s}.ts`);
		}
		lines.push('#EXT-X-ENDLIST');
		return lines.join('\n');
	}
}

export function createApp(service: VodService): Express {
	const app = express();
	app.use(express.json({ limit: '4kb' }));
	const find = (raw: string): Video | undefined => service.videos.get(Number(raw));
	const renditionOf = (name: string): number => LADDER.findIndex((r) => r.name === name);

	app.post('/videos', (req: Request, res: Response) => {
		const body = CreateVideo.safeParse(req.body);
		if (!body.success) {
			res.status(400).json({ error: 'invalid_body' });
			return;
		}
		const video = service.create(body.data.title, body.data.durationS);
		res.status(201).json({ id: video.id, status: video.status });
	});

	app.get('/videos/:id', (req: Request<{ id: string }>, res: Response) => {
		const video = find(req.params.id);
		if (video === undefined) {
			res.status(404).json({ error: 'not_found' });
			return;
		}
		res.json({ id: video.id, status: video.status });
	});

	app.get('/videos/:id/master.m3u8', (req: Request<{ id: string }>, res: Response) => {
		const video = find(req.params.id);
		if (
			video === undefined ||
			video.status.kind === 'uploaded' ||
			video.status.kind === 'processing'
		) {
			res.status(404).type('text/plain').send('not watchable yet');
			return;
		}
		res.setHeader(
			'Cache-Control',
			video.status.kind === 'ready' ? 'public, max-age=86400' : 'public, max-age=2'
		);
		res.type('application/vnd.apple.mpegurl').send(service.master(video));
	});

	app.get(
		'/videos/:id/:rendition/index.m3u8',
		(req: Request<{ id: string; rendition: string }>, res: Response) => {
			const video = find(req.params.id);
			const rendition = renditionOf(req.params.rendition);
			if (video === undefined || rendition < 0 || !service.complete(video, rendition)) {
				res.status(404).end();
				return;
			}
			res.setHeader('Cache-Control', 'public, max-age=86400');
			res.type('application/vnd.apple.mpegurl').send(service.media(video));
		}
	);

	app.get(
		'/videos/:id/:rendition/:segment.ts',
		(req: Request<{ id: string; rendition: string; segment: string }>, res: Response) => {
			const data = service.segments.get(
				`${req.params.id}/${req.params.rendition}/${req.params.segment}`
			);
			if (data === undefined) {
				res.status(404).end();
				return;
			}
			res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
			res.type('video/mp2t').send(data);
		}
	);

	return app;
}
