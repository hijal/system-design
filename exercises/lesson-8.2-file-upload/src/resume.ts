import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	GetObjectCommand,
	ListMultipartUploadsCommand,
	ListObjectsV2Command,
	ListPartsCommand,
	PutObjectCommand,
	UploadPartCommand,
	type CompletedPart
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { emptyBucket, env, mb, mulberry32, prepareBucket, s3, sendPut } from './common';

// Lesson 8.2 §1.3 — a big file, a broken network. A 200 MB screen recording, on a network where the connection
// tears on average after every DROP_EVERY_MB sent (a train, a lift, wifi to mobile data).
//
//   one PUT: when it tears, start the whole thing again from the beginning
//   multipart: the file in PART_MB pieces; when it tears, only that piece again; if the tab closes midway,
//              ListParts tells which ones exist and the rest are sent
//
// The uploads are real — presigned URLs, real object storage, and the connection really is cut midway. Which byte it
// tears at is seeded — the same every time. "Time" is a calculation: bytes sent ÷ NET_MBPS + RTT_MS per
// request (one round trip on mobile) — real time on a local network is meaninglessly fast.

const cfg = z
	.object({
		FILE_MB: z.coerce.number().positive().default(200),
		DROP_EVERY_MB: z.coerce.number().positive().default(60),
		NET_MBPS: z.coerce.number().positive().default(2.5), // ≈ 20 Mbps
		RTT_MS: z.coerce.number().nonnegative().default(150),
		MAX_ATTEMPTS: z.coerce.number().int().positive().default(15),
		MODEL_RUNS: z.coerce.number().int().positive().default(1000),
		SEED: z.coerce.number().int().default(11)
	})
	.parse(process.env);

const B = env.BUCKET;
const MB = 1024 * 1024;

// the broken network: after how many bytes it tears next (exponential, mean DROP_EVERY_MB) — keeps going across requests
class FlakyNetwork {
	private readonly random: () => number;
	private untilDrop: number;
	sent = 0;
	requests = 0;
	drops = 0;
	constructor(private readonly dropsEnabled: boolean) {
		this.random = mulberry32(cfg.SEED);
		this.untilDrop = this.next();
	}
	private next(): number {
		return -Math.log(1 - this.random()) * cfg.DROP_EVERY_MB * MB;
	}
	async put(url: string, body: Buffer): Promise<{ ok: true; etag: string } | { ok: false }> {
		this.requests++;
		const dropAt =
			this.dropsEnabled && this.untilDrop < body.length ? Math.floor(this.untilDrop) : null;
		const r = await sendPut(url, body, { dropAt });
		this.sent += r.sent;
		if (r.kind === 'dropped') {
			this.drops++;
			this.untilDrop = this.next();
			return { ok: false };
		}
		this.untilDrop -= body.length;
		if (r.status !== 200) throw new Error(`PUT ${r.status}`);
		return { ok: true, etag: r.etag ?? '' };
	}
	seconds(): number {
		return this.sent / (cfg.NET_MBPS * MB) + (this.requests * cfg.RTT_MS) / 1000;
	}
}

type Row = {
	name: string;
	done: boolean;
	net: FlakyNetwork;
	note: string;
	etag: string;
	intact: boolean;
};

async function verify(key: string, file: Buffer): Promise<boolean> {
	const res = await s3.send(new GetObjectCommand({ Bucket: B, Key: key }));
	const got = Buffer.from((await res.Body?.transformToByteArray()) ?? []);
	const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');
	return md5(got) === md5(file);
}

async function singlePut(name: string, file: Buffer, drops: boolean): Promise<Row> {
	const net = new FlakyNetwork(drops);
	const key = `recordings/single-${drops ? 'flaky' : 'clean'}`;
	for (let attempt = 1; attempt <= cfg.MAX_ATTEMPTS; attempt++) {
		// a new URL every time (from the app) — when it tears, start again from the beginning, the whole file
		const url = await getSignedUrl(
			s3,
			new PutObjectCommand({ Bucket: B, Key: key, ContentLength: file.length }),
			{
				expiresIn: 3600,
				signableHeaders: new Set(['content-length'])
			}
		);
		const r = await net.put(url, file);
		if (r.ok)
			return {
				name,
				done: true,
				net,
				note: `attempts: ${attempt}`,
				etag: r.etag,
				intact: await verify(key, file)
			};
	}
	return {
		name,
		done: false,
		net,
		note: `gave up after ${cfg.MAX_ATTEMPTS} attempts`,
		etag: '',
		intact: false
	};
}

async function multipart(
	name: string,
	file: Buffer,
	partMb: number,
	closeTabAt: number | null
): Promise<Row> {
	const net = new FlakyNetwork(true);
	const key = `recordings/multipart-${partMb}mb`;
	const partSize = partMb * MB;
	const count = Math.ceil(file.length / partSize);
	// 1. app: start the upload — one UploadId (kept in the database's pending row)
	const { UploadId } = await s3.send(
		new CreateMultipartUploadCommand({ Bucket: B, Key: key, ContentType: 'video/mp4' })
	);
	if (!UploadId) throw new Error('no UploadId');
	let done = new Map<number, string>(); // the browser's memory: which parts are done, and their ETags
	let retries = 0;
	let resumedWith = 0;
	for (let n = 1; n <= count; n++) {
		if (closeTabAt !== null && n === Math.floor(count * closeTabAt) + 1 && resumedWith === 0) {
			// the tab closed, the laptop slept — the browser's memory is gone. Coming back it asks the app: which ones arrived?
			done = new Map();
			const listed = await s3.send(new ListPartsCommand({ Bucket: B, Key: key, UploadId }));
			for (const p of listed.Parts ?? [])
				if (p.PartNumber && p.ETag) done.set(p.PartNumber, p.ETag);
			resumedWith = done.size;
		}
		if (done.has(n)) continue;
		const body = file.subarray((n - 1) * partSize, Math.min(file.length, n * partSize));
		// 2. each part gets its own presigned URL — the app signs, the browser sends directly
		const url = await getSignedUrl(
			s3,
			new UploadPartCommand({
				Bucket: B,
				Key: key,
				UploadId,
				PartNumber: n,
				ContentLength: body.length
			}),
			{ expiresIn: 3600, signableHeaders: new Set(['content-length']) }
		);
		let ok = false;
		for (let attempt = 1; attempt <= cfg.MAX_ATTEMPTS && !ok; attempt++) {
			const r = await net.put(url, body);
			if (r.ok) {
				done.set(n, r.etag);
				ok = true;
			} else retries++;
		}
		if (!ok)
			return { name, done: false, net, note: `gave up at part ${n}`, etag: '', intact: false };
	}
	// 3. app: stitch together with every part's number and ETag
	const parts: CompletedPart[] = [...done.entries()]
		.sort(([a], [b]) => a - b)
		.map(([PartNumber, ETag]) => ({ PartNumber, ETag }));
	const res = await s3.send(
		new CompleteMultipartUploadCommand({
			Bucket: B,
			Key: key,
			UploadId,
			MultipartUpload: { Parts: parts }
		})
	);
	const note = `${count} parts, ${retries} resent${resumedWith ? ` · after closing the tab ${resumedWith} were already there` : ''}`;
	return { name, done: true, net, note, etag: res.ETag ?? '', intact: await verify(key, file) };
}

async function abandoned(file: Buffer): Promise<void> {
	const key = 'recordings/abandoned';
	const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: B, Key: key }));
	if (!UploadId) throw new Error('no UploadId');
	for (let n = 1; n <= 3; n++) {
		await s3.send(
			new UploadPartCommand({
				Bucket: B,
				Key: key,
				UploadId,
				PartNumber: n,
				Body: file.subarray((n - 1) * 8 * MB, n * 8 * MB)
			})
		);
	}
	// the user left, and never came back
	const objects = await s3.send(new ListObjectsV2Command({ Bucket: B, Prefix: key }));
	const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: B, Prefix: key }));
	const parts = await s3.send(new ListPartsCommand({ Bucket: B, Key: key, UploadId }));
	const held = (parts.Parts ?? []).reduce((sum, p) => sum + (p.Size ?? 0), 0);
	console.log('── Unfinished upload (3 parts sent, then the user left) ──');
	console.log(
		`   visible in LIST objects: ${objects.KeyCount ?? 0} · unfinished multipart uploads: ${uploads.Uploads?.length ?? 0}, space used by parts ${mb(held)}`
	);
	await s3.send(new AbortMultipartUploadCommand({ Bucket: B, Key: key, UploadId }));
	const after = await s3.send(new ListMultipartUploadsCommand({ Bucket: B, Prefix: key }));
	console.log(`   unfinished uploads after AbortMultipartUpload: ${after.Uploads?.length ?? 0}\n`);
}

// the same broken-network model, without IO — on MODEL_RUNS different seeds, so you see the average, not one run's luck
function modelRun(
	seed: number,
	partMb: number | null,
	fileBytes: number
): { sent: number; requests: number; done: boolean } {
	const random = mulberry32(seed);
	const next = (): number => -Math.log(1 - random()) * cfg.DROP_EVERY_MB * MB;
	let untilDrop = next();
	let sent = 0;
	let requests = 0;
	const send = (bytes: number): boolean => {
		requests++;
		if (untilDrop < bytes) {
			sent += Math.floor(untilDrop);
			untilDrop = next();
			return false;
		}
		sent += bytes;
		untilDrop -= bytes;
		return true;
	};
	const pieces =
		partMb === null
			? [fileBytes]
			: Array.from({ length: Math.ceil(fileBytes / (partMb * MB)) }, (_, i) =>
					Math.min(partMb * MB, fileBytes - i * partMb * MB)
				);
	for (const piece of pieces) {
		let ok = false;
		for (let attempt = 1; attempt <= cfg.MAX_ATTEMPTS && !ok; attempt++) ok = send(piece);
		if (!ok) return { sent, requests, done: false };
	}
	return { sent, requests, done: true };
}

function modelTable(fileBytes: number): void {
	console.log(
		`── Model: the same network, ${cfg.MODEL_RUNS} different seeds (no IO, just byte accounting) ──`
	);
	console.log(
		'   method                       done    sent (avg, × file size)     time avg     time p95     requests'
	);
	for (const [name, partMb] of [
		['one PUT', null],
		['multipart, 5 MB part', 5],
		['multipart, 16 MB part', 16],
		['multipart, 64 MB part', 64]
	] as const) {
		const runs = Array.from({ length: cfg.MODEL_RUNS }, (_, i) =>
			modelRun(i + 1, partMb, fileBytes)
		);
		const done = runs.filter((r) => r.done);
		const secs = done
			.map((r) => r.sent / (cfg.NET_MBPS * MB) + (r.requests * cfg.RTT_MS) / 1000)
			.sort((a, b) => a - b);
		const avg = (xs: number[]): number =>
			xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
		const p95 = secs[Math.min(secs.length - 1, Math.floor(0.95 * secs.length))] ?? 0;
		const minutes = (x: number): string => (done.length ? `${(x / 60).toFixed(1)} min` : '—');
		console.log(
			`   ${name.padEnd(25)} ${`${((100 * done.length) / runs.length).toFixed(0)}%`.padStart(7)} ${(done.length ? (avg(done.map((r) => r.sent)) / fileBytes).toFixed(2) : '—').padStart(26)} ${minutes(avg(secs)).padStart(12)} ${minutes(p95).padStart(12)} ${(done.length ? avg(done.map((r) => r.requests)).toFixed(0) : '—').padStart(12)}`
		);
	}
	console.log(
		`   (not finished = some piece didn't arrive even after ${cfg.MAX_ATTEMPTS} attempts; times only for the finished ones)\n`
	);
}

async function main(): Promise<void> {
	await prepareBucket();
	await emptyBucket();
	const file = randomBytes(Math.round(cfg.FILE_MB * MB));
	console.log(
		`\n   a ${mb(file.length)} file · on average the network tears every ${cfg.DROP_EVERY_MB} MB · time computed at ${cfg.NET_MBPS} MB/s plus ${cfg.RTT_MS} ms per request\n`
	);
	const rows = [
		await singlePut('one PUT, network fine', file, false),
		await singlePut('one PUT, broken network', file, true),
		await multipart('multipart, 5 MB part', file, 5, null),
		await multipart('multipart, 16 MB part', file, 16, null),
		await multipart('multipart, 64 MB part', file, 64, null),
		await multipart('multipart, 16 MB, tab closed midway', file, 16, 0.5)
	];
	console.log(
		'   method                                  done?        sent    × file size  requests      torn      est. time   MD5 match   ETag'
	);
	for (const r of rows) {
		console.log(
			`   ${r.name.padEnd(36)} ${(r.done ? 'yes' : 'no').padStart(8)} ${mb(r.net.sent).padStart(11)} ${(r.net.sent / file.length).toFixed(2).padStart(14)} ${String(r.net.requests).padStart(9)} ${String(r.net.drops).padStart(9)} ${`${(r.net.seconds() / 60).toFixed(1)} min`.padStart(14)} ${(r.done ? (r.intact ? 'yes' : 'no') : '—').padStart(11)}   ${r.etag}`
		);
		console.log(`   ${''.padEnd(36)} ${r.note}`);
	}
	console.log();
	modelTable(file.length);
	await abandoned(file);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
