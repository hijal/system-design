import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { emptyBucket, env, mb, mulberry32, prepareBucket, s3 } from './common';

// Lesson 8.2 §1.5 - private files behind a CDN. A small "CDN" (Express, in this process) sits in front of object
// storage, and files are served three ways:
//   a) no CDN - every viewer takes their own presigned GET straight to object storage
//   b) a CDN, but every viewer's own presigned URL - the CDN uses the whole URL (with the query) as the cache key
//   c) the CDN's own signed token - the CDN verifies the token, uses only the path (without the token) as the cache key, and
//      on a miss fetches from object storage with its own credentials (the idea behind CloudFront's signed URLs/cookies)
// VIEWERS viewers, each opens one popular file (the webinar's release notes) and LONG_TAIL_VIEWS
// other files. Seeded - exactly the same numbers every time.

const cfg = z
	.object({
		VIEWERS: z.coerce.number().int().positive().default(300),
		LONG_TAIL_FILES: z.coerce.number().int().positive().default(200),
		LONG_TAIL_VIEWS: z.coerce.number().int().nonnegative().default(4),
		SEED: z.coerce.number().int().default(7)
	})
	.parse(process.env);

const B = env.BUCKET;
const CDN_SECRET = randomBytes(32); // a secret shared by the app and the CDN - not the object storage credentials

type Mode = 'direct' | 'cdn-presigned' | 'cdn-token';
type Counters = {
	requests: number;
	hits: number;
	originRequests: number;
	originBytes: number;
	rejected: number;
};

// the app's side: a time-limited token for the CDN - an HMAC of the path and the expiry
function cdnToken(path: string, expiresAt: number): string {
	return createHmac('sha256', CDN_SECRET).update(`${path}:${expiresAt}`).digest('base64url');
}

function verifyToken(path: string, exp: string, sig: string, now: number): boolean {
	const expiresAt = Number(exp);
	if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
	const expected = Buffer.from(cdnToken(path, expiresAt));
	const given = Buffer.from(sig);
	// timingSafeEqual only when the lengths are equal - to stop guessing the signature by measuring time
	return expected.length === given.length && timingSafeEqual(expected, given);
}

function startCdn(mode: Mode, counters: Counters): Promise<{ url: string; server: Server }> {
	const app = express();
	const cache = new Map<string, Buffer>();
	app.use((req: Request, res: Response, next: NextFunction): void => {
		void (async (): Promise<void> => {
			counters.requests++;
			const path = req.path; // `/${bucket}/${key}`
			let cacheKey = req.originalUrl; // b) the whole URL, with the query
			if (mode === 'cdn-token') {
				const q = z.object({ exp: z.string(), sig: z.string() }).safeParse(req.query);
				if (!q.success || !verifyToken(path, q.data.exp, q.data.sig, Date.now())) {
					counters.rejected++;
					res.status(403).end();
					return;
				}
				cacheKey = path; // c) without the token - one cache entry per file for everyone
			}
			const cached = cache.get(cacheKey);
			if (cached) {
				counters.hits++;
				res.type('application/pdf').send(cached);
				return;
			}
			let body: Buffer;
			if (mode === 'cdn-token') {
				// the CDN fetches from the origin with its own credentials (the bucket stays private - only the CDN can read it)
				const key = path.slice(`/${B}/`.length);
				const obj = await s3.send(new GetObjectCommand({ Bucket: B, Key: key }));
				body = Buffer.from((await obj.Body?.transformToByteArray()) ?? []);
			} else {
				// the viewer's presigned URL itself is sent to the origin - the origin verifies the signature
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
			const { port } = server.address() as AddressInfo; // after listen(0), address() is always an AddressInfo
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
	// every URL's signing time is in the past, but within the expiry (1 hour)
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
			// every viewer gets their own URL at a different moment (a different signingDate) - as in reality
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

	// who opens what: everyone the popular file, plus a few random other files
	const random = mulberry32(cfg.SEED);
	const views: string[] = [];
	for (let v = 0; v < cfg.VIEWERS; v++) {
		views.push(popular);
		for (let k = 0; k < cfg.LONG_TAIL_VIEWS; k++)
			views.push(tail[Math.floor(random() * tail.length)] ?? popular);
	}

	const rows = [
		await run('no CDN - presigned GET directly', 'direct', views),
		await run("CDN + each viewer's own presigned URL", 'cdn-presigned', views),
		await run("CDN + the CDN's signed token (path cached)", 'cdn-token', views)
	];
	console.log(
		`\n   ${cfg.VIEWERS} viewers · each opens the popular 5 MB file + ${cfg.LONG_TAIL_VIEWS} other files (among ${cfg.LONG_TAIL_FILES} files of 300 KB) = ${views.length} downloads\n`
	);
	console.log(
		'   path                                        download   cache hit    object storage requests      object storage egress'
	);
	for (const r of rows) {
		const hit = r.c.requests ? `${((100 * r.c.hits) / r.c.requests).toFixed(0)}%` : '-';
		console.log(
			`   ${r.name.padEnd(43)} ${String(r.c.requests).padStart(8)} ${hit.padStart(11)} ${String(r.c.originRequests).padStart(26)} ${mb(r.c.originBytes).padStart(26)}`
		);
	}

	// the token's safety: a changed path, and an expired token
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
		`\n   token for one file, a file from another workspace requested: ${tampered.status} · expired token: ${expired.status}\n`
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
