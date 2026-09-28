import {
	AbortMultipartUploadCommand,
	CreateBucketCommand,
	DeleteObjectsCommand,
	ListMultipartUploadsCommand,
	ListObjectsV2Command,
	PutBucketCorsCommand,
	S3Client,
	type S3ClientConfig
} from '@aws-sdk/client-s3';
import { request } from 'node:http';
import { z } from 'zod';

// Lesson 8.2 — সব script এর ভাগ করা অংশ: env, S3 client, bucket এর প্রস্তুতি, আর ধীর/ছিঁড়ে যাওয়া
// network এর মতো করে HTTP PUT পাঠানো।

export const env = z
	.object({
		S3_ENDPOINT: z.string().url().default('http://localhost:8336'),
		BUCKET: z.string().default('taskflow-uploads'),
		// s3.json এ দেওয়া identity — শুধু API server এর কাছে থাকে, browser কখনো দেখে না
		S3_ACCESS_KEY: z.string().default('taskflow'),
		S3_SECRET_KEY: z.string().default('taskflow-secret')
	})
	.parse(process.env);

export function s3Client(extra: Partial<S3ClientConfig> = {}): S3Client {
	return new S3Client({
		endpoint: env.S3_ENDPOINT,
		region: 'us-east-1',
		forcePathStyle: true,
		credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
		// AWS SDK v3 এর নতুন version default এ presigned PUT এর URL এ body এর একটা checksum বসায় —
		// sign করার সময় body নেই, তাই খালি body এর checksum; আসল file এলে server বলে BadDigest।
		// শুধু যেখানে দরকার সেখানে checksum (presign.ts এর ৭ নম্বর পরীক্ষা এই ফাঁদটা দেখায়)
		requestChecksumCalculation: 'WHEN_REQUIRED',
		...extra
	});
}

export const s3 = s3Client();

export const APP_ORIGIN = 'https://app.taskflow.test';

export async function prepareBucket(): Promise<void> {
	try {
		await s3.send(new CreateBucketCommand({ Bucket: env.BUCKET }));
	} catch (error: unknown) {
		const name = error instanceof Error ? error.name : '';
		if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
			console.error('S3 পাওয়া যাচ্ছে না — আগে `docker compose up -d --wait`।');
			throw error;
		}
	}
	// Browser অন্য origin থেকে সরাসরি bucket এ PUT করবে — তাই bucket এ CORS এর নিয়ম লাগে
	await s3.send(
		new PutBucketCorsCommand({
			Bucket: env.BUCKET,
			CORSConfiguration: {
				CORSRules: [
					{
						AllowedOrigins: [APP_ORIGIN],
						AllowedMethods: ['PUT', 'GET'],
						AllowedHeaders: ['content-type', 'content-length'],
						ExposeHeaders: ['ETag'], // multipart এ প্রতিটা part এর ETag browser কে পড়তে হয়
						MaxAgeSeconds: 3600
					}
				]
			}
		})
	);
}

// সব object আর অসমাপ্ত multipart upload মুছে পরিষ্কার শুরু
export async function emptyBucket(): Promise<void> {
	const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: env.BUCKET }));
	for (const u of uploads.Uploads ?? []) {
		if (u.Key && u.UploadId)
			await s3.send(
				new AbortMultipartUploadCommand({ Bucket: env.BUCKET, Key: u.Key, UploadId: u.UploadId })
			);
	}
	for (;;) {
		const page = await s3.send(new ListObjectsV2Command({ Bucket: env.BUCKET, MaxKeys: 1000 }));
		const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
		if (keys.length === 0) return;
		await s3.send(new DeleteObjectsCommand({ Bucket: env.BUCKET, Delete: { Objects: keys } }));
	}
}

export type SendResult =
	| { kind: 'done'; status: number; etag: string | null; sent: number }
	| { kind: 'dropped'; sent: number };

// একটা HTTP PUT, টুকরো টুকরো করে লেখা:
//   mbps     — প্রতি সেকেন্ডে কত MB (০ = যত দ্রুত পারে) — ধীর user এর মতো
//   dropAt   — এত byte পাঠানোর পরে connection ছিঁড়ে যায় (network চলে গেল); null = ছেঁড়ে না
// fetch এর বদলে node:http কারণ: মাঝপথে ঠিক একটা byte এ connection কাটা, আর Content-Length সহ stream।
export function sendPut(
	url: string,
	body: Buffer,
	opts: { mbps?: number; dropAt?: number | null; headers?: Record<string, string> } = {}
): Promise<SendResult> {
	const chunk = 64 * 1024;
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		let sent = 0;
		let dropped = false;
		const req = request(
			{
				method: 'PUT',
				hostname: target.hostname,
				port: target.port,
				path: `${target.pathname}${target.search}`,
				headers: { 'content-length': String(body.length), ...opts.headers }
			},
			(res) => {
				res.resume();
				res.on('end', () =>
					resolve({
						kind: 'done',
						status: res.statusCode ?? 0,
						etag: typeof res.headers.etag === 'string' ? res.headers.etag : null,
						sent
					})
				);
			}
		);
		req.on('error', (error) => (dropped ? resolve({ kind: 'dropped', sent }) : reject(error)));
		const start = performance.now();
		const writeNext = (): void => {
			if (sent >= body.length) {
				req.end();
				return;
			}
			const end = Math.min(body.length, sent + chunk);
			if (opts.dropAt != null && end > opts.dropAt) {
				sent = Math.max(sent, opts.dropAt);
				dropped = true;
				req.destroy(); // network গেল — server অর্ধেক body পেয়ে থামে
				return;
			}
			const ok = req.write(body.subarray(sent, end));
			sent = end;
			const mbps = opts.mbps ?? 0;
			// ধীর user: যতটা পাঠানো হলো, সেই অনুপাতে সময় না হওয়া পর্যন্ত অপেক্ষা
			const wait =
				mbps > 0 ? (sent / (mbps * 1024 * 1024)) * 1000 - (performance.now() - start) : 0;
			const go = (): void => void setTimeout(writeNext, Math.max(0, wait));
			if (ok) go();
			else req.once('drain', go); // backpressure (Lesson 7.4) — socket এর buffer ভরা
		};
		writeNext();
	});
}

export const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const ms = (value: number): string =>
	value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;

export function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

// Seeded PRNG (mulberry32) — প্রতিবার একই "random" ক্রম
export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
