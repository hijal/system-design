import { z } from 'zod';
import { createApp, VodService } from './vod';
import { heading, padEnd } from './util';

const Created = z.object({ id: z.number() });
const StatusBody = z.object({ status: z.object({ kind: z.string() }).passthrough() });

const service = new VodService();

let step = 0;
const show = (what: string, result: string): void => {
	step++;
	console.log(padEnd(step, 4) + padEnd(what, 54) + result);
};

async function main(): Promise<void> {
	const server = createApp(service).listen(0);
	await new Promise<void>((resolve) => server.once('listening', () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('could not get the port');
	const base = `http://127.0.0.1:${address.port}`;
	const get = async (
		path: string
	): Promise<{ status: number; body: string; cache: string; bytes: number }> => {
		const res = await fetch(`${base}${path}`);
		const buffer = Buffer.from(await res.arrayBuffer());
		return {
			status: res.status,
			body: buffer.toString('utf8'),
			cache: res.headers.get('cache-control') ?? '-',
			bytes: buffer.length
		};
	};
	const status = async (id: number): Promise<string> => {
		const s = StatusBody.parse(JSON.parse((await get(`/videos/${id}`)).body)).status;
		return 'done' in s ? `${s.kind} (${String(s['done'])}/${String(s['total'])})` : s.kind;
	};

	heading('one VOD service: a 1-minute video, 4 s pieces, 5 resolutions, HLS playlists');
	console.log(padEnd('#', 4) + padEnd('step', 54) + 'result');

	const res = await fetch(`${base}/videos`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title: 'demo', durationS: 60 })
	});
	const { id } = Created.parse(await res.json());
	show(
		'upload done, jobs in the pipeline',
		`id ${id}; ${service.queue.length} jobs in the queue (15 pieces × 5)`
	);
	show('master playlist, nothing built yet', `${(await get(`/videos/${id}/master.m3u8`)).status}`);

	service.work(30);
	show('30 jobs (360p and 240p first)', await status(id));
	const early = await get(`/videos/${id}/master.m3u8`);
	show(
		'the master playlist now',
		`${early.body
			.split('\n')
			.filter((l) => l.endsWith('.m3u8'))
			.join(', ')}; Cache-Control: ${early.cache}`
	);

	service.failNext.add(`${id}/720p/3`);
	service.work(1_000);
	show(
		'the remaining jobs; the worker on 720p piece 3 died',
		`${await status(id)}; failed ${service.stats.failures}, ran ${service.stats.jobsRun}`
	);

	const master = await get(`/videos/${id}/master.m3u8`);
	show('master playlist (ready)', `Cache-Control: ${master.cache}`);
	for (const line of master.body.split('\n')) console.log(padEnd('', 58) + line);

	const media = await get(`/videos/${id}/480p/index.m3u8`);
	show("480p's playlist (first 5 lines)", media.body.split('\n').slice(0, 5).join(' | '));

	const parse = (body: string): { mbps: number; uri: string }[] => {
		const lines = body.split('\n');
		const out: { mbps: number; uri: string }[] = [];
		lines.forEach((l, i) => {
			const m = /BANDWIDTH=(\d+)/.exec(l);
			const uri = lines[i + 1];
			if (m !== null && m[1] !== undefined && uri !== undefined)
				out.push({ mbps: Number(m[1]) / 1e6, uri });
		});
		return out;
	};
	for (const bw of [1, 3, 8]) {
		const choice =
			parse(master.body)
				.filter((r) => r.mbps <= bw * 0.8)
				.pop() ?? parse(master.body)[0];
		const rendition = choice?.uri.split('/')[0] ?? '240p';
		const seg = await get(`/videos/${id}/${rendition}/0.ts`);
		show(`player, network ${bw} Mbps (80% rule)`, `${rendition}; first piece ${seg.bytes} B`);
	}
	const seg = await get(`/videos/${id}/1080p/7.ts`);
	show("a piece's Cache-Control", seg.cache);

	service.redeliver({ video: id, rendition: 2, segment: 5 });
	service.work(10);
	show(
		'the queue handed out the same job again (at-least-once)',
		`${service.stats.writes} new writes in total, ${service.stats.skippedDuplicate} skipped`
	);

	server.close();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
