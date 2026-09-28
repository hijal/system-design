import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { APP_ORIGIN, emptyBucket, env, prepareBucket, s3, s3Client } from './common';

// Lesson 8.2 §১.২ — presigned URL এর নিয়ম, আসল request দিয়ে। প্রতিটা পরীক্ষা একটা প্রশ্ন:
// "এই URL হাতে পেলে কেউ কী করতে পারে, আর কী পারে না?" শেষে confirm ধাপ — upload এর পরে app নিজে যাচাই করে।

const B = env.BUCKET;

// Attachment এর অবস্থা — discriminated union, optional field এর জঙ্গল না (main.md এর নিয়ম)
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

// app এর দিক: upload এর অনুমতি। Key app বানায়, আকার আর ধরন sign করা থাকে।
async function presignUpload(
	size: number,
	contentType: string,
	expiresIn = 300
): Promise<{ attachment: Attachment; url: string }> {
	const key = `ws/12/att/${randomUUID()}`;
	const url = await getSignedUrl(
		s3,
		new PutObjectCommand({ Bucket: B, Key: key, ContentType: contentType, ContentLength: size }),
		// যা sign করা, শুধু সেটাই আটকায় — content-type আর content-length কে স্পষ্টভাবে sign এর তালিকায়
		{ expiresIn, signableHeaders: new Set(['content-type', 'content-length']) }
	);
	return { attachment: { status: 'pending', key, declaredSize: size, contentType }, url };
}

// app এর দিক: browser বলল "upload শেষ" — বিশ্বাস না করে object storage কে জিজ্ঞেস করা
async function confirm(a: Attachment): Promise<Attachment> {
	if (a.status !== 'pending') return a;
	try {
		const head = await s3.send(new HeadObjectCommand({ Bucket: B, Key: a.key }));
		if (head.ContentLength !== a.declaredSize || head.ContentType !== a.contentType) {
			await s3.send(new DeleteObjectCommand({ Bucket: B, Key: a.key }));
			return {
				status: 'rejected',
				key: a.key,
				reason: `আকার ${head.ContentLength ?? '?'} (বলা ছিল ${a.declaredSize}) — object মুছে ফেলা হলো`
			};
		}
		return { status: 'ready', key: a.key, size: head.ContentLength, etag: head.ETag ?? '' };
	} catch {
		return { status: 'rejected', key: a.key, reason: 'object নেই — upload হয়নি' };
	}
}

async function main(): Promise<void> {
	await prepareBucket();
	await emptyBucket();
	const pdf = Buffer.from('%PDF-1.7 … release notes …');
	console.log('\n── Upload এর presigned URL (PUT) ──');

	const a = await presignUpload(pdf.length, 'application/pdf');
	line(1, 'ঠিক file, ঠিক content-type', String(await put(a.url, pdf, 'application/pdf')));
	line(2, 'একই URL দিয়ে আবার (মেয়াদের মধ্যে)', String(await put(a.url, pdf, 'application/pdf')));
	line(3, 'একই URL, content-type বদলে (text/html)', String(await put(a.url, pdf, 'text/html')));
	const otherKey = a.url.replace(/att\/[0-9a-f-]+/, 'att/someone-elses-file');
	line(
		4,
		'URL এর key বদলে অন্য object এ লেখার চেষ্টা',
		String(await put(otherKey, pdf, 'application/pdf'))
	);
	line(
		5,
		'বড় file, একই URL (আকার sign করা)',
		String(await put(a.url, Buffer.alloc(50 * pdf.length, 1), 'application/pdf'))
	);

	const short = await presignUpload(pdf.length, 'application/pdf', 2);
	await new Promise((resolve) => setTimeout(resolve, 3500));
	line(6, 'মেয়াদ ২ s, ৩.৫ s পরে ব্যবহার', String(await put(short.url, pdf, 'application/pdf')));

	// আকার sign না করলে: URL বলে "যেকোনো আকার চলবে"
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
		'আকার sign না করা URL এ ৫০ গুণ বড় file',
		String(await put(loose, Buffer.alloc(50 * pdf.length, 1), 'application/pdf'))
	);

	// SDK এর default (checksum সহ) দিয়ে sign করলে
	const defaultClient = s3Client({ requestChecksumCalculation: 'WHEN_SUPPORTED' });
	const trap = await getSignedUrl(
		defaultClient,
		new PutObjectCommand({ Bucket: B, Key: `ws/12/att/${randomUUID()}` }),
		{ expiresIn: 300 }
	);
	const trapRes = await fetch(trap, { method: 'PUT', body: pdf });
	const trapCode = /<Code>(\w+)<\/Code>/.exec(await trapRes.text())?.[1] ?? '';
	line(8, 'SDK এর default checksum সহ sign করা URL', `${trapRes.status} ${trapCode}`);

	console.log('\n── Confirm: browser বলল "শেষ", app যাচাই করে ──');
	const good = await presignUpload(pdf.length, 'application/pdf');
	await put(good.url, pdf, 'application/pdf');
	const never = await presignUpload(pdf.length, 'application/pdf');
	for (const [label, att] of [
		['ঠিকঠাক upload', good.attachment],
		['URL নিয়েছে, upload করেনি', never.attachment]
	] as const) {
		const result = await confirm(att);
		const text =
			result.status === 'ready'
				? `ready (ETag ${result.etag})`
				: `${result.status}: ${result.status === 'rejected' ? result.reason : ''}`;
		console.log(`       ${label.padEnd(40)} → ${text}`);
	}
	// sign না করা আকারের পথে কেউ বড় file দিলে confirm ধরে
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
		`       ${'আকার sign ছিল না, বড় file এসেছে'.padEnd(40)} → ${caught.status}${caught.status === 'rejected' ? `: ${caught.reason}` : ''}`
	);

	console.log('\n── Download এর presigned URL (GET) ──');
	const readyKey = good.attachment.key;
	const get = await getSignedUrl(
		s3,
		new GetObjectCommand({
			Bucket: B,
			Key: readyKey,
			// download এ কী নাম দেখাবে — প্রতিটা URL এ আলাদা হতে পারে (user এর দেওয়া নাম database থেকে)
			ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent('রিলিজ নোট.pdf')}`
		}),
		{ expiresIn: 60 }
	);
	const got = await fetch(get);
	await got.arrayBuffer();
	line(9, 'presigned GET', `${got.status} · ${got.headers.get('content-disposition') ?? ''}`);
	const anon = await fetch(`${env.S3_ENDPOINT}/${B}/${readyKey}`);
	await anon.arrayBuffer();
	line(10, 'একই object, signature ছাড়া', String(anon.status));

	console.log(
		'\n── CORS: browser অন্য origin থেকে bucket এ PUT করার আগে জিজ্ঞেস করে (preflight) ──'
	);
	for (const origin of [APP_ORIGIN, 'https://evil.example']) {
		const pre = await fetch(`${env.S3_ENDPOINT}/${B}/${readyKey}`, {
			method: 'OPTIONS',
			headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' }
		});
		await pre.arrayBuffer();
		console.log(
			`       ${origin.padEnd(40)} → ${pre.status} · allow-origin: ${pre.headers.get('access-control-allow-origin') ?? '(নেই)'}`
		);
	}
	console.log();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
