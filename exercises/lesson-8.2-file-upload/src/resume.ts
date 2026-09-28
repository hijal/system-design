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

// Lesson 8.2 §১.৩ — বড় file, ভাঙা network। একটা ২০০ MB এর screen recording, এমন network এ যেখানে গড়ে
// প্রতি DROP_EVERY_MB পাঠানোর পরে connection ছিঁড়ে যায় (train, lift, wifi থেকে mobile data)।
//
//   একটা PUT: ছিঁড়লে পুরোটা আবার শুরু থেকে
//   multipart: file টা PART_MB এর টুকরোয়; ছিঁড়লে শুধু সেই টুকরো আবার; মাঝপথে tab বন্ধ হলে
//              ListParts দিয়ে কোনগুলো আছে জেনে বাকিটা
//
// Upload গুলো আসল — presigned URL, আসল object storage, আর connection আসলেই মাঝপথে কাটা হয়। কোন byte এ
// ছিঁড়বে সেটা seed দেওয়া — প্রতিবার একই। "সময়" হলো একটা হিসাব: পাঠানো byte ÷ NET_MBPS + প্রতিটা request এ
// RTT_MS (mobile এ একটা round trip) — local network এ আসল সময় অর্থহীন দ্রুত।

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

// ভাঙা network: কত byte পরে পরের বার ছিঁড়বে (exponential, গড় DROP_EVERY_MB) — request পার হয়েও চলতে থাকে
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
		// প্রতিবার নতুন URL (app থেকে) — ছিঁড়লে শুরু থেকে আবার, পুরো file
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
				note: `${attempt} বার চেষ্টা`,
				etag: r.etag,
				intact: await verify(key, file)
			};
	}
	return {
		name,
		done: false,
		net,
		note: `${cfg.MAX_ATTEMPTS} বার চেষ্টার পরে হাল ছাড়ল`,
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
	// ১. app: upload শুরু — একটা UploadId (database এর pending row এ রাখা হয়)
	const { UploadId } = await s3.send(
		new CreateMultipartUploadCommand({ Bucket: B, Key: key, ContentType: 'video/mp4' })
	);
	if (!UploadId) throw new Error('no UploadId');
	let done = new Map<number, string>(); // browser এর memory: কোন part শেষ, তার ETag
	let retries = 0;
	let resumedWith = 0;
	for (let n = 1; n <= count; n++) {
		if (closeTabAt !== null && n === Math.floor(count * closeTabAt) + 1 && resumedWith === 0) {
			// tab বন্ধ, laptop ঘুমাল — browser এর memory শেষ। ফিরে এসে app কে জিজ্ঞেস: কোনগুলো পৌঁছেছে?
			done = new Map();
			const listed = await s3.send(new ListPartsCommand({ Bucket: B, Key: key, UploadId }));
			for (const p of listed.Parts ?? [])
				if (p.PartNumber && p.ETag) done.set(p.PartNumber, p.ETag);
			resumedWith = done.size;
		}
		if (done.has(n)) continue;
		const body = file.subarray((n - 1) * partSize, Math.min(file.length, n * partSize));
		// ২. প্রতিটা part এর নিজের presigned URL — app sign করে, browser সরাসরি পাঠায়
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
			return { name, done: false, net, note: `part ${n} এ হাল ছাড়ল`, etag: '', intact: false };
	}
	// ৩. app: সব part এর নম্বর আর ETag দিয়ে জোড়া লাগানো
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
	const note = `${count} টা part, ${retries} টা আবার${resumedWith ? ` · tab বন্ধের পরে ${resumedWith} টা আগে থেকেই ছিল` : ''}`;
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
	// user চলে গেল, আর কখনো ফিরল না
	const objects = await s3.send(new ListObjectsV2Command({ Bucket: B, Prefix: key }));
	const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: B, Prefix: key }));
	const parts = await s3.send(new ListPartsCommand({ Bucket: B, Key: key, UploadId }));
	const held = (parts.Parts ?? []).reduce((sum, p) => sum + (p.Size ?? 0), 0);
	console.log('── অসমাপ্ত upload (৩টা part পাঠিয়ে user চলে গেল) ──');
	console.log(
		`   LIST objects এ দেখা যায়: ${objects.KeyCount ?? 0} টা · অসমাপ্ত multipart upload: ${uploads.Uploads?.length ?? 0} টা, part গুলোর জায়গা ${mb(held)}`
	);
	await s3.send(new AbortMultipartUploadCommand({ Bucket: B, Key: key, UploadId }));
	const after = await s3.send(new ListMultipartUploadsCommand({ Bucket: B, Prefix: key }));
	console.log(`   AbortMultipartUpload এর পরে অসমাপ্ত upload: ${after.Uploads?.length ?? 0} টা\n`);
}

// একই ভাঙা network এর model, IO ছাড়া — MODEL_RUNS টা আলাদা seed এ, যাতে একটা run এর ভাগ্য না, গড় দেখা যায়
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
		`── Model: একই network, ${cfg.MODEL_RUNS} টা আলাদা seed (IO ছাড়া, শুধু byte এর হিসাব) ──`
	);
	console.log(
		'   পদ্ধতি                    শেষ হলো    পাঠানো (গড়, file এর গুণ)   সময় গড়      সময় p95      request গড়'
	);
	for (const [name, partMb] of [
		['একটা PUT', null],
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
		const minutes = (x: number): string => (done.length ? `${(x / 60).toFixed(1)} মিনিট` : '—');
		console.log(
			`   ${name.padEnd(25)} ${`${((100 * done.length) / runs.length).toFixed(0)}%`.padStart(7)} ${(done.length ? (avg(done.map((r) => r.sent)) / fileBytes).toFixed(2) : '—').padStart(26)} ${minutes(avg(secs)).padStart(12)} ${minutes(p95).padStart(12)} ${(done.length ? avg(done.map((r) => r.requests)).toFixed(0) : '—').padStart(12)}`
		);
	}
	console.log(
		`   (শেষ না হওয়া = কোনো একটা টুকরো ${cfg.MAX_ATTEMPTS} বার চেষ্টাতেও পৌঁছায়নি; সময় শুধু শেষ হওয়া গুলোর)\n`
	);
}

async function main(): Promise<void> {
	await prepareBucket();
	await emptyBucket();
	const file = randomBytes(Math.round(cfg.FILE_MB * MB));
	console.log(
		`\n   ${mb(file.length)} এর file · network গড়ে প্রতি ${cfg.DROP_EVERY_MB} MB এ ছিঁড়ে যায় · সময়ের হিসাব ${cfg.NET_MBPS} MB/s আর প্রতি request এ ${cfg.RTT_MS} ms\n`
	);
	const rows = [
		await singlePut('একটা PUT, network ঠিক থাকলে', file, false),
		await singlePut('একটা PUT, ভাঙা network', file, true),
		await multipart('multipart, 5 MB part', file, 5, null),
		await multipart('multipart, 16 MB part', file, 16, null),
		await multipart('multipart, 64 MB part', file, 64, null),
		await multipart('multipart, 16 MB, মাঝপথে tab বন্ধ', file, 16, 0.5)
	];
	console.log(
		'   পদ্ধতি                               শেষ হলো?   পাঠানো      file এর কত গুণ   request   ছিঁড়েছে   আনুমানিক সময়   MD5 মিলেছে   ETag'
	);
	for (const r of rows) {
		console.log(
			`   ${r.name.padEnd(36)} ${(r.done ? 'হ্যাঁ' : 'না').padStart(8)} ${mb(r.net.sent).padStart(11)} ${(r.net.sent / file.length).toFixed(2).padStart(14)} ${String(r.net.requests).padStart(9)} ${String(r.net.drops).padStart(9)} ${`${(r.net.seconds() / 60).toFixed(1)} মিনিট`.padStart(14)} ${(r.done ? (r.intact ? 'হ্যাঁ' : 'না') : '—').padStart(11)}   ${r.etag}`
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
