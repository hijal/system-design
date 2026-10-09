import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { APP_ORIGIN, emptyBucket, env, prepareBucket, s3, s3Client } from './common';

// Lesson 8.2 §1.2 - the rules of presigned URLs, with real requests. Every test is one question:
// "what can someone do with this URL in hand, and what can't they?" At the end a confirm step - after the upload the app verifies itself.

const B = env.BUCKET;

// An attachment's state - a discriminated union, not a jungle of optional fields (main.md's rule)
type Attachment =
	| { status: 'pending'; key: string; declaredSize: number; contentType: string }
	| { status: 'ready'; key: string; size: number; etag: string }
	| { status: 'rejected'; key: string; reason: string };

const line = (n: number, text: string, result: string): void =>
	console.log(`   ${String(n).padStart(2)}. ${text.padEnd(62)} → ${result}`);

async function put(url: string, body: string | Buffer, contentType?: string): Promise<number> {
	const headers: Record<string, string> = contentType ? { 'content-type': contentType } : {};
	const res = await fetch(url, { method: 'PUT', body, headers });
	await res.arrayBuffer();
	return res.status;
}

// the app's side: permission to upload. The app builds the key; the size and type are signed.
async function presignUpload(
	size: number,
	contentType: string,
	expiresIn = 300
): Promise<{ attachment: Attachment; url: string }> {
	const key = `ws/12/att/${randomUUID()}`;
	const url = await getSignedUrl(
		s3,
		new PutObjectCommand({ Bucket: B, Key: key, ContentType: contentType, ContentLength: size }),
		// only what is signed is enforced - content-type and content-length explicitly in the signed list
		{ expiresIn, signableHeaders: new Set(['content-type', 'content-length']) }
	);
	return { attachment: { status: 'pending', key, declaredSize: size, contentType }, url };
}

// the app's side: the browser said "upload done" - ask object storage instead of trusting it
async function confirm(a: Attachment): Promise<Attachment> {
	if (a.status !== 'pending') return a;
	try {
		const head = await s3.send(new HeadObjectCommand({ Bucket: B, Key: a.key }));
		if (head.ContentLength !== a.declaredSize || head.ContentType !== a.contentType) {
			await s3.send(new DeleteObjectCommand({ Bucket: B, Key: a.key }));
			return {
				status: 'rejected',
				key: a.key,
				reason: `size ${head.ContentLength ?? '?'} (declared ${a.declaredSize}) - object deleted`
			};
		}
		return { status: 'ready', key: a.key, size: head.ContentLength, etag: head.ETag ?? '' };
	} catch {
		return { status: 'rejected', key: a.key, reason: 'no object - not uploaded' };
	}
}

async function main(): Promise<void> {
	await prepareBucket();
	await emptyBucket();
	const pdf = Buffer.from('%PDF-1.7 … release notes …');
	console.log('\n── Presigned URL for upload (PUT) ──');

	const a = await presignUpload(pdf.length, 'application/pdf');
	line(1, 'correct file, correct content-type', String(await put(a.url, pdf, 'application/pdf')));
	line(2, 'the same URL again (before expiry)', String(await put(a.url, pdf, 'application/pdf')));
	line(
		3,
		'the same URL, content-type changed (text/html)',
		String(await put(a.url, pdf, 'text/html'))
	);
	const otherKey = a.url.replace(/att\/[0-9a-f-]+/, 'att/someone-elses-file');
	line(
		4,
		"changing the URL's key to write to another object",
		String(await put(otherKey, pdf, 'application/pdf'))
	);
	line(
		5,
		'a bigger file, the same URL (size signed)',
		String(await put(a.url, Buffer.alloc(50 * pdf.length, 1), 'application/pdf'))
	);

	const short = await presignUpload(pdf.length, 'application/pdf', 2);
	await new Promise((resolve) => setTimeout(resolve, 3500));
	line(6, 'expiry 2 s, used after 3.5 s', String(await put(short.url, pdf, 'application/pdf')));

	// without signing the size: the URL says "any size is fine"
	const loose = await getSignedUrl(
		s3,
		new PutObjectCommand({
			Bucket: B,
			Key: `ws/12/att/${randomUUID()}`,
			ContentType: 'application/pdf'
		}),
		{ expiresIn: 300, signableHeaders: new Set(['content-type']) }
	);
	line(
		7,
		'a file 50 times bigger on a URL without the size signed',
		String(await put(loose, Buffer.alloc(50 * pdf.length, 1), 'application/pdf'))
	);

	// signing with the SDK's default (with a checksum)
	const defaultClient = s3Client({ requestChecksumCalculation: 'WHEN_SUPPORTED' });
	const trap = await getSignedUrl(
		defaultClient,
		new PutObjectCommand({ Bucket: B, Key: `ws/12/att/${randomUUID()}` }),
		{ expiresIn: 300 }
	);
	const trapRes = await fetch(trap, { method: 'PUT', body: pdf });
	const trapCode = /<Code>(\w+)<\/Code>/.exec(await trapRes.text())?.[1] ?? '';
	line(8, "URL signed with the SDK's default checksum", `${trapRes.status} ${trapCode}`);

	console.log('\n── Confirm: the browser said "done", the app verifies ──');
	const good = await presignUpload(pdf.length, 'application/pdf');
	await put(good.url, pdf, 'application/pdf');
	const never = await presignUpload(pdf.length, 'application/pdf');
	for (const [label, att] of [
		['correct upload', good.attachment],
		['took the URL, never uploaded', never.attachment]
	] as const) {
		const result = await confirm(att);
		const text =
			result.status === 'ready'
				? `ready (ETag ${result.etag})`
				: `${result.status}: ${result.status === 'rejected' ? result.reason : ''}`;
		console.log(`       ${label.padEnd(40)} → ${text}`);
	}
	// if someone sends a big file on the unsigned-size path, confirm catches it
	const bigKey = `ws/12/att/${randomUUID()}`;
	const bigUrl = await getSignedUrl(
		s3,
		new PutObjectCommand({ Bucket: B, Key: bigKey, ContentType: 'application/pdf' }),
		{
			expiresIn: 300,
			signableHeaders: new Set(['content-type'])
		}
	);
	await put(bigUrl, Buffer.alloc(50 * pdf.length, 1), 'application/pdf');
	const caught = await confirm({
		status: 'pending',
		key: bigKey,
		declaredSize: pdf.length,
		contentType: 'application/pdf'
	});
	console.log(
		`       ${'size not signed, a bigger file arrived'.padEnd(40)} → ${caught.status}${caught.status === 'rejected' ? `: ${caught.reason}` : ''}`
	);

	console.log('\n── Presigned URL for download (GET) ──');
	const readyKey = good.attachment.key;
	const get = await getSignedUrl(
		s3,
		new GetObjectCommand({
			Bucket: B,
			Key: readyKey,
			// what name the download shows - can differ per URL (the user-given name from the database)
			ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent('Release notes - v2.1.pdf')}`
		}),
		{ expiresIn: 60 }
	);
	const got = await fetch(get);
	await got.arrayBuffer();
	line(9, 'presigned GET', `${got.status} · ${got.headers.get('content-disposition') ?? ''}`);
	const anon = await fetch(`${env.S3_ENDPOINT}/${B}/${readyKey}`);
	await anon.arrayBuffer();
	line(10, 'the same object, without a signature', String(anon.status));

	console.log(
		'\n── CORS: the browser asks before PUTting to the bucket from another origin (preflight) ──'
	);
	for (const origin of [APP_ORIGIN, 'https://evil.example']) {
		const pre = await fetch(`${env.S3_ENDPOINT}/${B}/${readyKey}`, {
			method: 'OPTIONS',
			headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' }
		});
		await pre.arrayBuffer();
		console.log(
			`       ${origin.padEnd(40)} → ${pre.status} · allow-origin: ${pre.headers.get('access-control-allow-origin') ?? '(none)'}`
		);
	}
	console.log();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
