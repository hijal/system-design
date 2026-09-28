import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { emptyBucket, env, mb, mulberry32, prepareBucket, s3 } from './common';

// Lesson 8.2 §১.৫ — private file, CDN এর পেছনে। একটা ছোট "CDN" (Express, এই process এ) object storage
// এর সামনে বসে, আর তিনভাবে file দেওয়া হয়:
//   ক) CDN নেই — প্রত্যেক viewer নিজের presigned GET নিয়ে সরাসরি object storage এ
//   খ) CDN, কিন্তু প্রত্যেক viewer এর নিজের presigned URL — CDN পুরো URL (query সহ) কে cache key ধরে
//   গ) CDN এর নিজের signed token — CDN token যাচাই করে, token বাদ দিয়ে শুধু path কে cache key ধরে, আর
//      miss হলে নিজের credential দিয়ে object storage থেকে আনে (CloudFront এর signed URL/cookie এর ধারণা)
// VIEWERS জন viewer, প্রত্যেকে একটা জনপ্রিয় file (webinar এর release notes) আর LONG_TAIL_VIEWS টা
// অন্য file খোলে। Seed দেওয়া — প্রতিবার হুবহু একই সংখ্যা।

const cfg = z
	.object({
		VIEWERS: z.coerce.number().int().positive().default(300),
		LONG_TAIL_FILES: z.coerce.number().int().positive().default(200),
		LONG_TAIL_VIEWS: z.coerce.number().int().nonnegative().default(4),
		SEED: z.coerce.number().int().default(7)
	})
	.parse(process.env);

const B = env.BUCKET;
const CDN_SECRET = randomBytes(32); // app আর CDN এর ভাগ করা secret — object storage এর credential না

type Mode = 'direct' | 'cdn-presigned' | 'cdn-token';
type Counters = {
	requests: number;
	hits: number;
	originRequests: number;
	originBytes: number;
	rejected: number;
};

// app এর দিক: CDN এর জন্য সীমিত সময়ের token — path আর মেয়াদ এর HMAC
function cdnToken(path: string, expiresAt: number): string {
	return createHmac('sha256', CDN_SECRET).update(`${path}:${expiresAt}`).digest('base64url');
}

function verifyToken(path: string, exp: string, sig: string, now: number): boolean {
	const expiresAt = Number(exp);
	if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
	const expected = Buffer.from(cdnToken(path, expiresAt));
	const given = Buffer.from(sig);
	// সমান দৈর্ঘ্য হলে তবেই timingSafeEqual — সময় মেপে signature আন্দাজ করা আটকাতে
	return expected.length === given.length && timingSafeEqual(expected, given);
}

function startCdn(mode: Mode, counters: Counters): Promise<{ url: string; server: Server }> {
	const app = express();
	const cache = new Map<string, Buffer>();
	app.use((req: Request, res: Response, next: NextFunction): void => {
		void (async (): Promise<void> => {
			counters.requests++;
			const path = req.path; // `/${bucket}/${key}`
			let cacheKey = req.originalUrl; // খ) query সহ পুরো URL
			if (mode === 'cdn-token') {
				const q = z.object({ exp: z.string(), sig: z.string() }).safeParse(req.query);
				if (!q.success || !verifyToken(path, q.data.exp, q.data.sig, Date.now())) {
					counters.rejected++;
					res.status(403).end();
					return;
				}
				cacheKey = path; // গ) token বাদ — একই file সবার জন্য একটাই cache entry
			}
			const cached = cache.get(cacheKey);
			if (cached) {
				counters.hits++;
				res.type('application/pdf').send(cached);
				return;
			}
			let body: Buffer;
			if (mode === 'cdn-token') {
				// CDN নিজের credential দিয়ে origin থেকে আনে (bucket private থাকে — শুধু CDN পড়তে পারে)
				const key = path.slice(`/${B}/`.length);
				const obj = await s3.send(new GetObjectCommand({ Bucket: B, Key: key }));
				body = Buffer.from((await obj.Body?.transformToByteArray()) ?? []);
			} else {
				// viewer এর presigned URL টাই origin এ পাঠানো — signature origin যাচাই করে
				const origin = await fetch(`${env.S3_ENDPOINT}${req.originalUrl}`);
				if (origin.status !== 200) {
					res.status(origin.status).end();
					return;
				}
				body = Buffer.from(await origin.arrayBuffer());
			}
			counters.originRequests++;
			counters.originBytes += body.length;
			cache.set(cacheKey, body);
			res.type('application/pdf').send(body);
		})().catch(next);
	});
	return new Promise((resolve) => {
		const server = app.listen(0, () => {
			const { port } = server.address() as AddressInfo; // listen(0) এর পরে address() সবসময় AddressInfo
			resolve({ url: `http://127.0.0.1:${port}`, server });
		});
	});
}

async function run(
	name: string,
	mode: Mode,
	views: string[]
): Promise<{ name: string; c: Counters }> {
	const c: Counters = { requests: 0, hits: 0, originRequests: 0, originBytes: 0, rejected: 0 };
	const cdn = mode === 'direct' ? null : await startCdn(mode, c);
	// সব URL এর signing সময় অতীতে, কিন্তু মেয়াদের (১ ঘণ্টা) মধ্যে
	const base = Date.now() - views.length * 1000;
	let i = 0;
	for (const key of views) {
		i++;
		let url: string;
		if (mode === 'cdn-token') {
			const exp = Date.now() + 5 * 60_000;
			const path = `/${B}/${key}`;
			url = `${cdn?.url ?? ''}${path}?exp=${exp}&sig=${cdnToken(path, exp)}`;
		} else {
			// প্রত্যেক viewer আলাদা মুহূর্তে নিজের URL পায় (signingDate আলাদা) — বাস্তবের মতো
			const signed = await getSignedUrl(s3, new GetObjectCommand({ Bucket: B, Key: key }), {
				expiresIn: 3600,
				signingDate: new Date(base + i * 1000)
			});
			url = cdn ? signed.replace(env.S3_ENDPOINT, cdn.url) : signed;
		}
		const res = await fetch(url);
		const body = Buffer.from(await res.arrayBuffer());
		if (res.status !== 200) throw new Error(`${name}: ${res.status} for ${key}`);
		if (mode === 'direct') {
			c.requests++;
			c.originRequests++;
			c.originBytes += body.length;
		}
	}
	if (cdn) await new Promise((resolve) => cdn.server.close(resolve));
	return { name, c };
}

async function main(): Promise<void> {
	await prepareBucket();
	await emptyBucket();
	const popular = 'ws/12/att/release-notes-2-1.pdf';
	await s3.send(
		new PutObjectCommand({ Bucket: B, Key: popular, Body: randomBytes(5 * 1024 * 1024) })
	);
	const tail = Array.from({ length: cfg.LONG_TAIL_FILES }, (_, n) => `ws/12/att/file-${n}.pdf`);
	for (const key of tail)
		await s3.send(new PutObjectCommand({ Bucket: B, Key: key, Body: randomBytes(300 * 1024) }));

	// কে কী খোলে: প্রত্যেকে জনপ্রিয় file টা, আর কয়েকটা এলোমেলো অন্য file
	const random = mulberry32(cfg.SEED);
	const views: string[] = [];
	for (let v = 0; v < cfg.VIEWERS; v++) {
		views.push(popular);
		for (let k = 0; k < cfg.LONG_TAIL_VIEWS; k++)
			views.push(tail[Math.floor(random() * tail.length)] ?? popular);
	}

	const rows = [
		await run('CDN নেই — সরাসরি presigned GET', 'direct', views),
		await run('CDN + প্রত্যেকের নিজের presigned URL', 'cdn-presigned', views),
		await run('CDN + CDN এর signed token (path এ cache)', 'cdn-token', views)
	];
	console.log(
		`\n   ${cfg.VIEWERS} জন viewer · প্রত্যেকে জনপ্রিয় 5 MB file + ${cfg.LONG_TAIL_VIEWS} টা অন্য file (${cfg.LONG_TAIL_FILES} টা 300 KB এর মধ্যে) = ${views.length} টা download\n`
	);
	console.log(
		'   পথ                                          download   cache hit   object storage এ request   object storage থেকে বেরোল'
	);
	for (const r of rows) {
		const hit = r.c.requests ? `${((100 * r.c.hits) / r.c.requests).toFixed(0)}%` : '—';
		console.log(
			`   ${r.name.padEnd(43)} ${String(r.c.requests).padStart(8)} ${hit.padStart(11)} ${String(r.c.originRequests).padStart(26)} ${mb(r.c.originBytes).padStart(26)}`
		);
	}

	// token এর নিরাপত্তা: path বদলানো, আর মেয়াদ পেরোনো
	const c: Counters = { requests: 0, hits: 0, originRequests: 0, originBytes: 0, rejected: 0 };
	const cdn = await startCdn('cdn-token', c);
	const exp = Date.now() + 60_000;
	const path = `/${B}/${popular}`;
	const other = `/${B}/ws/40/att/secret.pdf`;
	const past = Date.now() - 1000;
	const tampered = await fetch(`${cdn.url}${other}?exp=${exp}&sig=${cdnToken(path, exp)}`);
	const expired = await fetch(`${cdn.url}${path}?exp=${past}&sig=${cdnToken(path, past)}`);
	await Promise.all([tampered.arrayBuffer(), expired.arrayBuffer()]);
	await new Promise((resolve) => cdn.server.close(resolve));
	console.log(
		`\n   token এক file এর, চাওয়া অন্য workspace এর file: ${tampered.status} · মেয়াদ পেরোনো token: ${expired.status}\n`
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
