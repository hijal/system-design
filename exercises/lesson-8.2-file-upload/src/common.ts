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

// Lesson 8.2 — the part shared by every script: env, the S3 client, preparing the bucket, and sending an HTTP PUT
// the way a slow/tearing network would.

export const env = z
	.object({
		S3_ENDPOINT: z.string().url().default('http://localhost:8336'),
		BUCKET: z.string().default('taskflow-uploads'),
		// the identity given in s3.json — kept only on the API server, the browser never sees it
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
		// Newer versions of AWS SDK v3 by default put a checksum of the body in a presigned PUT's URL —
		// at signing time there is no body, so it's the checksum of an empty body; when the real file arrives the server says BadDigest.
		// checksums only where needed (presign.ts's test 7 shows this trap)
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
			console.error('S3 cannot be reached — run `docker compose up -d --wait` first.');
			throw error;
		}
	}
	// The browser will PUT straight to the bucket from another origin — so the bucket needs CORS rules
	await s3.send(
		new PutBucketCorsCommand({
			Bucket: env.BUCKET,
			CORSConfiguration: {
				CORSRules: [
					{
						AllowedOrigins: [APP_ORIGIN],
						AllowedMethods: ['PUT', 'GET'],
						AllowedHeaders: ['content-type', 'content-length'],
						ExposeHeaders: ['ETag'], // with multipart the browser has to read each part's ETag
						MaxAgeSeconds: 3600
					}
				]
			}
		})
	);
}

// delete every object and unfinished multipart upload for a clean start
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

// An HTTP PUT, written piece by piece:
//   mbps     — how many MB per second (0 = as fast as it can) — like a slow user
//   dropAt   — the connection tears after this many bytes (the network went away); null = never tears
// node:http instead of fetch because: cutting the connection at exactly one byte midway, and a stream with Content-Length.
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
				req.destroy(); // the network went — the server stops with half a body
				return;
			}
			const ok = req.write(body.subarray(sent, end));
			sent = end;
			const mbps = opts.mbps ?? 0;
			// a slow user: wait until enough time has passed for what has been sent
			const wait =
				mbps > 0 ? (sent / (mbps * 1024 * 1024)) * 1000 - (performance.now() - start) : 0;
			const go = (): void => void setTimeout(writeNext, Math.max(0, wait));
			if (ok) go();
			else req.once('drain', go); // backpressure (Lesson 7.4) — the socket's buffer is full
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

// Seeded PRNG (mulberry32) — the same "random" sequence every time
export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
