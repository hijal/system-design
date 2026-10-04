import { z } from 'zod';
import { createApp, VodService } from './vod';
import { heading, padEnd } from './util';

const Created = z.object({ id: z.number() });
const StatusBody = z.object({ status: z.object({ kind: z.string() }).passthrough() });

const service = new VodService();

let step = 0;
const show = (what: string, result: string): void => {
	step++;
	console.log(padEnd(step, 4) + padEnd(what, 50) + result);
};

async function main(): Promise<void> {
	const server = createApp(service).listen(0);
	await new Promise<void>((resolve) => server.once('listening', () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('port পাওয়া গেল না');
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

	heading('একটা VOD service: ১ মিনিটের video, ৪ s এর টুকরো, ৫টা resolution, HLS এর playlist');
	console.log(padEnd('#', 4) + padEnd('ধাপ', 50) + 'ফল');

	const res = await fetch(`${base}/videos`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title: 'demo', durationS: 60 })
	});
	const { id } = Created.parse(await res.json());
	show(
		'upload শেষ, pipeline এ কাজ',
		`id ${id}; queue এ ${service.queue.length}টা কাজ (১৫ টুকরো × ৫)`
	);
	show('master playlist, কিছুই তৈরি হয়নি', `${(await get(`/videos/${id}/master.m3u8`)).status}`);

	service.work(30);
	show('৩০টা কাজ (360p আর 240p আগে)', await status(id));
	const early = await get(`/videos/${id}/master.m3u8`);
	show(
		'master playlist এখন',
		`${early.body
			.split('\n')
			.filter((l) => l.endsWith('.m3u8'))
			.join(', ')}; Cache-Control: ${early.cache}`
	);

	service.failNext.add(`${id}/720p/3`);
	service.work(1_000);
	show(
		'বাকি কাজ; 720p এর টুকরো ৩ এর worker মরল',
		`${await status(id)}; ব্যর্থ ${service.stats.failures}, চালানো ${service.stats.jobsRun}`
	);

	const master = await get(`/videos/${id}/master.m3u8`);
	show('master playlist (ready)', `Cache-Control: ${master.cache}`);
	for (const line of master.body.split('\n')) console.log(padEnd('', 54) + line);

	const media = await get(`/videos/${id}/480p/index.m3u8`);
	show('480p এর playlist (প্রথম ৫ লাইন)', media.body.split('\n').slice(0, 5).join(' | '));

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
		show(`player, network ${bw} Mbps (৮০% নিয়ম)`, `${rendition}; প্রথম টুকরো ${seg.bytes} B`);
	}
	const seg = await get(`/videos/${id}/1080p/7.ts`);
	show('একটা টুকরোর Cache-Control', seg.cache);

	service.redeliver({ video: id, rendition: 2, segment: 5 });
	service.work(10);
	show(
		'queue একই কাজ আবার দিল (at-least-once)',
		`নতুন লেখা ${service.stats.writes}টা মোট, বাদ দেওয়া ${service.stats.skippedDuplicate}`
	);

	server.close();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
