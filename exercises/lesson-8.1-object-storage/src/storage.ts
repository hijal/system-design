import {
	CreateBucketCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { z } from 'zod';

// Lesson 8.1 — the part shared by every script: env, the Postgres pool, the S3 client, and a few small helpers.

export const env = z
	.object({
		DATABASE_URL: z.string().default('postgres://taskflow:taskflow@localhost:5445/taskflow'),
		S3_ENDPOINT: z.string().url().default('http://localhost:8335'),
		BUCKET: z.string().default('taskflow-attachments')
	})
	.parse(process.env);

export function pgPool(max: number): Pool {
	return new Pool({ connectionString: env.DATABASE_URL, max });
}

// SeaweedFS has no identity config, so any key works; on real S3 these are IAM credentials.
// forcePathStyle: `http://host/bucket/key` — for a local S3-compatible server
// (AWS's own default is `http://bucket.host/key`).
export const s3 = new S3Client({
	endpoint: env.S3_ENDPOINT,
	region: 'us-east-1',
	forcePathStyle: true,
	credentials: { accessKeyId: 'taskflow', secretAccessKey: 'taskflow-secret' }
});

export async function ensureBucket(bucket: string): Promise<void> {
	try {
		await s3.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (error: unknown) {
		// fine if it already exists — any other error is a real problem
		const name = error instanceof Error ? error.name : '';
		if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
	}
}

// Delete every object in the bucket — for a clean start on every run. There is no "delete folder" API:
// list, then delete 1000 at a time (S3's DeleteObjects limit) — §1.6's flat namespace.
export async function emptyBucket(bucket: string): Promise<number> {
	let deleted = 0;
	for (;;) {
		const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
		const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
		if (keys.length === 0) return deleted;
		await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
		deleted += keys.length;
	}
}

export async function putObject(
	bucket: string,
	key: string,
	body: Buffer,
	contentType = 'application/octet-stream'
): Promise<string> {
	const res = await s3.send(
		new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
	);
	return res.ETag ?? '';
}

// read the whole object into a Buffer — null if not found (404)
export async function getObject(bucket: string, key: string): Promise<Buffer | null> {
	try {
		const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
		if (!res.Body) return null;
		return Buffer.from(await res.Body.transformToByteArray());
	} catch (error: unknown) {
		if (error instanceof Error && error.name === 'NoSuchKey') return null;
		throw error;
	}
}

export async function checkServices(pool: Pool): Promise<void> {
	try {
		await pool.query('SELECT 1');
		await ensureBucket(env.BUCKET);
	} catch (error: unknown) {
		console.error('Postgres or S3 cannot be reached — run `docker compose up -d --wait` first.');
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
