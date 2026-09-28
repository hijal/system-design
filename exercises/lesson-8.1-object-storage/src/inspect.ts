import {
	CopyObjectCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectVersionsCommand,
	ListObjectsV2Command,
	PutBucketVersioningCommand,
	PutObjectCommand
} from '@aws-sdk/client-s3';
import { createHash, randomBytes } from 'node:crypto';
import {
	checkServices,
	emptyBucket,
	ensureBucket,
	env,
	getObject,
	pgPool,
	putObject,
	s3
} from './storage';

// Lesson 8.1 §১.৬ — object storage এর API একটা file system না। সাতটা ছোট পরীক্ষা, প্রতিটা একটা নিয়ম:
//   ১. লেখার পরেই পড়া — নতুন মান পাওয়া যায় কি?        ৫. ETag আর MD5
//   ২. "Folder" — আসলে key এর prefix                     ৬. দুজন একসাথে লিখলে — last writer wins, আর conditional write
//   ৩. পুরো object লেখা, কিন্তু আংশিক পড়া (range)       ৭. Versioning — overwrite আর delete এর পরে পুরনো version
//   ৪. Metadata — body না নামিয়ে (HEAD)

const B = env.BUCKET;
const VERSIONED = `${env.BUCKET}-versioned`;

const status = (error: unknown): string => {
	if (error instanceof Error && '$metadata' in error) {
		const meta = error.$metadata;
		const code =
			typeof meta === 'object' && meta !== null && 'httpStatusCode' in meta
				? meta.httpStatusCode
				: '?';
		return `${String(code)} ${error.name}`;
	}
	return String(error);
};

async function readAfterWrite(): Promise<void> {
	let stale = 0;
	for (let i = 0; i < 200; i++) {
		const body = `version-${i}`;
		await putObject(B, 'raw/counter.txt', Buffer.from(body));
		const got = (await getObject(B, 'raw/counter.txt'))?.toString();
		if (got !== body) stale++;
	}
	console.log('── ১. লেখার পরেই পড়া (একই key তে ২০০ বার overwrite, প্রতিবার সাথে সাথে GET) ──');
	console.log(`   পুরনো মান ফেরত এসেছে: ${stale} / 200\n`);
}

async function prefixes(): Promise<void> {
	const keys = [
		'workspaces/12/tasks/42/spec.pdf',
		'workspaces/12/tasks/42/mockup.png',
		'workspaces/12/tasks/43/notes.txt',
		'workspaces/12/avatar.png',
		'workspaces/40/tasks/7/report.pdf'
	];
	for (const k of keys) await putObject(B, k, Buffer.from(k));
	const list = await s3.send(
		new ListObjectsV2Command({ Bucket: B, Prefix: 'workspaces/12/', Delimiter: '/' })
	);
	console.log('── ২. "Folder" — আসলে key এর prefix ──');
	console.log("   LIST Prefix='workspaces/12/' Delimiter='/':");
	for (const c of list.Contents ?? []) console.log(`     object  ${c.Key}`);
	for (const p of list.CommonPrefixes ?? [])
		console.log(`     "folder" ${p.Prefix}   ← কোনো আসল জিনিস না, শুধু key এর মিল`);
	// "folder এর নাম বদলাও" — S3 এ rename নেই: প্রতিটা object copy, তারপর delete
	const all = await s3.send(new ListObjectsV2Command({ Bucket: B, Prefix: 'workspaces/12/' }));
	let requests = 1;
	for (const c of all.Contents ?? []) {
		if (!c.Key) continue;
		const target = c.Key.replace('workspaces/12/', 'workspaces/99/');
		await s3.send(new CopyObjectCommand({ Bucket: B, Key: target, CopySource: `${B}/${c.Key}` }));
		await s3.send(new DeleteObjectCommand({ Bucket: B, Key: c.Key }));
		requests += 2;
	}
	console.log(
		`   workspaces/12/ → workspaces/99/ "rename": ${requests} টা request (১ LIST + প্রতিটা object এ COPY + DELETE)\n`
	);
}

async function wholeObjectRangeRead(): Promise<void> {
	const size = 8 * 1024 * 1024;
	const body = randomBytes(size);
	await putObject(B, 'raw/design.psd', body);
	// ১ byte বদলাতে চাই — append, "এই offset এ লেখো" জাতীয় কোনো API নেই: পুরো object আবার PUT
	body[1000] = (body[1000] ?? 0) ^ 0xff;
	await s3.send(new PutObjectCommand({ Bucket: B, Key: 'raw/design.psd', Body: body }));
	// কিন্তু পড়া আংশিক হতে পারে — Range header (video এর মাঝখান থেকে চালানো, বড় file এর অংশ)
	const part = await s3.send(
		new GetObjectCommand({ Bucket: B, Key: 'raw/design.psd', Range: 'bytes=4194304-4195327' })
	);
	const got = Buffer.from((await part.Body?.transformToByteArray()) ?? []);
	console.log('── ৩. লেখা পুরো object, পড়া আংশিক হতে পারে ──');
	console.log(`   ১ byte বদলাতে পাঠাতে হলো: ${body.length.toLocaleString('en')} byte (পুরো 8 MB)`);
	console.log(
		`   মাঝখান থেকে 1 KB পড়তে এলো: ${got.length} byte · ${part.ContentRange ?? ''} · মিলেছে: ${got.equals(body.subarray(4194304, 4195328)) ? 'হ্যাঁ' : 'না'}\n`
	);
}

async function metadataAndEtag(): Promise<void> {
	const body = randomBytes(300_000);
	await s3.send(
		new PutObjectCommand({
			Bucket: B,
			Key: 'raw/spec.pdf',
			Body: body,
			ContentType: 'application/pdf',
			ContentDisposition: 'attachment; filename="Release 2.1 spec.pdf"',
			Metadata: { 'task-id': '42', 'uploaded-by': '9' }
		})
	);
	const head = await s3.send(new HeadObjectCommand({ Bucket: B, Key: 'raw/spec.pdf' }));
	const md5 = createHash('md5').update(body).digest('hex');
	console.log('── ৪. Metadata — HEAD, body ছাড়া ──');
	console.log(
		`   আকার ${head.ContentLength ?? 0} · ${head.ContentType ?? ''} · ${head.ContentDisposition ?? ''}`
	);
	console.log(`   নিজের metadata: ${JSON.stringify(head.Metadata ?? {})}\n`);
	console.log('── ৫. ETag ──');
	console.log(`   ETag ${head.ETag ?? ''}`);
	console.log(
		`   MD5  "${md5}"  → ${head.ETag === `"${md5}"` ? 'একই (একবারে PUT করা object এ)' : 'আলাদা'}\n`
	);
}

async function concurrentWrites(): Promise<void> {
	const key = 'raw/task-42-checklist.json';
	await putObject(B, key, Buffer.from(JSON.stringify({ items: ['draft'] })));
	type Doc = { items: string[] };
	const read = async (): Promise<{ doc: Doc; etag: string }> => {
		const res = await s3.send(new GetObjectCommand({ Bucket: B, Key: key }));
		const text = (await res.Body?.transformToString()) ?? '{"items":[]}';
		const parsed: unknown = JSON.parse(text);
		const items =
			typeof parsed === 'object' &&
			parsed !== null &&
			'items' in parsed &&
			Array.isArray(parsed.items)
				? parsed.items.filter((x): x is string => typeof x === 'string')
				: [];
		return { doc: { items }, etag: res.ETag ?? '' };
	};

	// ক) দুজন পড়ল, দুজন নিজের item যোগ করে লিখল — কোনো শর্ত ছাড়া
	const [a, b] = await Promise.all([read(), read()]);
	await putObject(
		B,
		key,
		Buffer.from(JSON.stringify({ items: [...a.doc.items, 'Rahim: review'] }))
	);
	await putObject(
		B,
		key,
		Buffer.from(JSON.stringify({ items: [...b.doc.items, 'Karim: deploy'] }))
	);
	const plain = (await read()).doc.items;

	// খ) একই কাজ, If-Match দিয়ে — "আমি যেটা পড়েছি, সেটাই যদি এখনো থাকে তবেই লেখো"
	await putObject(B, key, Buffer.from(JSON.stringify({ items: ['draft'] })));
	const [c, d] = await Promise.all([read(), read()]);
	const conditional = async (seen: { doc: Doc; etag: string }, item: string): Promise<string> => {
		try {
			await s3.send(
				new PutObjectCommand({
					Bucket: B,
					Key: key,
					Body: JSON.stringify({ items: [...seen.doc.items, item] }),
					IfMatch: seen.etag
				})
			);
			return 'লেখা হলো';
		} catch (error: unknown) {
			return `প্রত্যাখ্যাত (${status(error)})`;
		}
	};
	const first = await conditional(c, 'Rahim: review');
	const second = await conditional(d, 'Karim: deploy');
	let retried = '';
	if (second.startsWith('প্রত্যাখ্যাত')) {
		retried = await conditional(await read(), 'Karim: deploy'); // আবার পড়ে, আবার চেষ্টা
	}
	const guarded = (await read()).doc.items;

	// গ) If-None-Match: * — "শুধু না থাকলে তৈরি করো" (একই নামের দুটো upload এর দ্বিতীয়টা আটকায়)
	const createOnly = await s3
		.send(new PutObjectCommand({ Bucket: B, Key: key, Body: 'x', IfNoneMatch: '*' }))
		.then(
			() => 'লেখা হলো (?)',
			(error: unknown) => `প্রত্যাখ্যাত (${status(error)})`
		);

	console.log('── ৬. দুজন একসাথে একই object বদলাল ──');
	console.log(
		`   শর্ত ছাড়া:            ${JSON.stringify(plain)}   ← Rahim এর item নীরবে হারাল (last writer wins)`
	);
	console.log(
		`   If-Match (ETag):       Rahim ${first} · Karim ${second} · আবার পড়ে Karim ${retried || '—'}`
	);
	console.log(`                          ${JSON.stringify(guarded)}`);
	console.log(`   If-None-Match: * (আগে থেকে আছে এমন key এ): ${createOnly}\n`);
}

async function versioning(): Promise<void> {
	await ensureBucket(VERSIONED);
	await s3.send(
		new PutBucketVersioningCommand({
			Bucket: VERSIONED,
			VersioningConfiguration: { Status: 'Enabled' }
		})
	);
	const key = `logo-${Date.now()}.png`;
	const v1 = await s3.send(
		new PutObjectCommand({ Bucket: VERSIONED, Key: key, Body: 'version one' })
	);
	await s3.send(new PutObjectCommand({ Bucket: VERSIONED, Key: key, Body: 'version two' }));
	await s3.send(new DeleteObjectCommand({ Bucket: VERSIONED, Key: key }));
	const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: VERSIONED, Prefix: key }));
	const now = await getObject(VERSIONED, key);
	const old = await s3.send(
		new GetObjectCommand({ Bucket: VERSIONED, Key: key, VersionId: v1.VersionId })
	);
	const oldBody = (await old.Body?.transformToString()) ?? '';
	// ফিরিয়ে আনা: পুরনো version কে নতুন version হিসেবে copy
	await s3.send(
		new CopyObjectCommand({
			Bucket: VERSIONED,
			Key: key,
			CopySource: `${VERSIONED}/${key}?versionId=${v1.VersionId ?? ''}`
		})
	);
	const restored = (await getObject(VERSIONED, key))?.toString() ?? '(নেই)';
	console.log('── ৭. Versioning (আলাদা bucket, versioning চালু) ──');
	console.log(`   PUT "version one" → PUT "version two" → DELETE`);
	console.log(
		`   version আছে: ${versions.Versions?.length ?? 0} · delete marker: ${versions.DeleteMarkers?.length ?? 0} · সাধারণ GET: ${now ? 'পাওয়া গেল' : '404'}`
	);
	console.log(
		`   প্রথম version টা VersionId দিয়ে: "${oldBody}" · copy করে ফিরিয়ে আনার পরে GET: "${restored}"\n`
	);
}

async function main(): Promise<void> {
	const pool = pgPool(1);
	await checkServices(pool);
	await pool.end();
	await emptyBucket(B);
	console.log();
	await readAfterWrite();
	await prefixes();
	await wholeObjectRangeRead();
	await metadataAndEtag();
	await concurrentWrites();
	await versioning();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
