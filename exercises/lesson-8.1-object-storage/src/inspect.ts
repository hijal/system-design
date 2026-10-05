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

// Lesson 8.1 §1.6 — object storage's API is not a file system. Seven small tests, each one a rule:
//   1. read right after write — is the new value returned?   5. ETag and MD5
//   2. "Folder" — really a key prefix                         6. two writers at once — last writer wins, and conditional writes
//   3. write the whole object, but read part of it (range)   7. Versioning — old versions after overwrite and delete
//   4. Metadata — without downloading the body (HEAD)

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
	console.log(
		'── 1. Read right after write (200 overwrites of one key, each followed immediately by a GET) ──'
	);
	console.log(`   old value returned: ${stale} / 200\n`);
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
	console.log('── 2. "Folder" — really just a key prefix ──');
	console.log("   LIST Prefix='workspaces/12/' Delimiter='/':");
	for (const c of list.Contents ?? []) console.log(`     object  ${c.Key}`);
	for (const p of list.CommonPrefixes ?? [])
		console.log(`     "folder" ${p.Prefix}   ← not a real thing, just keys that match`);
	// "rename the folder" — S3 has no rename: copy every object, then delete
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
		`   workspaces/12/ → workspaces/99/ "rename": ${requests} requests (1 LIST + COPY + DELETE per object)\n`
	);
}

async function wholeObjectRangeRead(): Promise<void> {
	const size = 8 * 1024 * 1024;
	const body = randomBytes(size);
	await putObject(B, 'raw/design.psd', body);
	// to change 1 byte — there is no append or "write at this offset" API: PUT the whole object again
	body[1000] = (body[1000] ?? 0) ^ 0xff;
	await s3.send(new PutObjectCommand({ Bucket: B, Key: 'raw/design.psd', Body: body }));
	// but a read can be partial — the Range header (playing a video from the middle, part of a big file)
	const part = await s3.send(
		new GetObjectCommand({ Bucket: B, Key: 'raw/design.psd', Range: 'bytes=4194304-4195327' })
	);
	const got = Buffer.from((await part.Body?.transformToByteArray()) ?? []);
	console.log('── 3. Writes are whole-object, reads can be partial ──');
	console.log(
		`   to change 1 byte, had to send: ${body.length.toLocaleString('en')} bytes (the whole 8 MB)`
	);
	console.log(
		`   reading 1 KB from the middle returned: ${got.length} bytes · ${part.ContentRange ?? ''} · matches: ${got.equals(body.subarray(4194304, 4195328)) ? 'yes' : 'no'}\n`
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
	console.log('── 4. Metadata — HEAD, without the body ──');
	console.log(
		`   size ${head.ContentLength ?? 0} · ${head.ContentType ?? ''} · ${head.ContentDisposition ?? ''}`
	);
	console.log(`   custom metadata: ${JSON.stringify(head.Metadata ?? {})}\n`);
	console.log('── 5. ETag ──');
	console.log(`   ETag ${head.ETag ?? ''}`);
	console.log(
		`   MD5  "${md5}"  → ${head.ETag === `"${md5}"` ? 'the same (for an object PUT in one go)' : 'different'}\n`
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

	// a) two people read, both add their own item and write — without any condition
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

	// b) the same work, with If-Match — "write only if what I read is still there"
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
			return 'wrote';
		} catch (error: unknown) {
			return `rejected (${status(error)})`;
		}
	};
	const first = await conditional(c, 'Rahim: review');
	const second = await conditional(d, 'Karim: deploy');
	let retried = '';
	if (second.startsWith('rejected')) {
		retried = await conditional(await read(), 'Karim: deploy'); // read again, try again
	}
	const guarded = (await read()).doc.items;

	// c) If-None-Match: * — "create only if it doesn't exist" (stops the second of two uploads with the same name)
	const createOnly = await s3
		.send(new PutObjectCommand({ Bucket: B, Key: key, Body: 'x', IfNoneMatch: '*' }))
		.then(
			() => 'wrote (?)',
			(error: unknown) => `rejected (${status(error)})`
		);

	console.log('── 6. Two people changed the same object at once ──');
	console.log(
		`   unconditional:         ${JSON.stringify(plain)}   ← Rahim's item silently lost (last writer wins)`
	);
	console.log(
		`   If-Match (ETag):       Rahim ${first} · Karim ${second} · after re-reading, Karim ${retried || '—'}`
	);
	console.log(`                          ${JSON.stringify(guarded)}`);
	console.log(`   If-None-Match: * (on a key that already exists): ${createOnly}\n`);
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
	// restoring: copy the old version as a new version
	await s3.send(
		new CopyObjectCommand({
			Bucket: VERSIONED,
			Key: key,
			CopySource: `${VERSIONED}/${key}?versionId=${v1.VersionId ?? ''}`
		})
	);
	const restored = (await getObject(VERSIONED, key))?.toString() ?? '(missing)';
	console.log('── 7. Versioning (a separate bucket, with versioning on) ──');
	console.log(`   PUT "version one" → PUT "version two" → DELETE`);
	console.log(
		`   versions present: ${versions.Versions?.length ?? 0} · delete markers: ${versions.DeleteMarkers?.length ?? 0} · plain GET: ${now ? 'found' : '404'}`
	);
	console.log(
		`   the first version by VersionId: "${oldBody}" · GET after copying it back: "${restored}"\n`
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
