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

// Lesson 8.1 — সব script এর ভাগ করা অংশ: env, Postgres pool, S3 client, আর কয়েকটা ছোট helper।

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

// SeaweedFS এ কোনো identity config নেই, তাই যেকোনো key চলে; আসল S3 এ এগুলো IAM এর credential।
// forcePathStyle: `http://host/bucket/key` — local S3-compatible server এর জন্য
// (AWS এর নিজের default `http://bucket.host/key`)।
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
		// আগে থেকেই থাকলে ঠিক আছে — অন্য সব error আসল সমস্যা
		const name = error instanceof Error ? error.name : '';
		if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
	}
}

// Bucket এর সব object মুছে ফেলা — প্রতিটা run পরিষ্কার শুরু করতে। "folder মোছা" বলে কোনো API নেই:
// list করো, তারপর ১০০০ করে delete (S3 এর DeleteObjects এর সীমা) — §১.৬ এর flat namespace।
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

// পুরো object পড়ে Buffer — না পেলে null (404)
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
		console.error('Postgres বা S3 পাওয়া যাচ্ছে না — আগে `docker compose up -d --wait`।');
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
