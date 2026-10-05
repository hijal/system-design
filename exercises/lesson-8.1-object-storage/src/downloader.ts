import { z } from 'zod';
import { env, getObject, pgPool } from './storage';
import { mulberry32 } from './random';

// Lesson 8.1 — where.ts's child process: downloading files from outside the app.
//   SOURCE=s3 — the way a browser/CDN downloads straight from object storage (8.2's presigned URL); the app isn't touched
//   SOURCE=db — from Postgres, but outside the app's process and pool — only to measure the load on the database
// A separate process because: in the same Node process the CPU for pulling the file's bytes would also enter OLTP latency.

const cfgSchema = z.object({
	SOURCE: z.enum(['db', 's3']),
	PHASE_MS: z.coerce.number().int().positive(),
	DOWNLOADERS: z.coerce.number().int().positive(),
	FILES: z.coerce.number().int().positive(),
	SEED: z.coerce.number().int()
});

// child → parent: 'ready' first (connected, measurement started), the result at the end
export const messageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ready') }),
	z.object({ type: z.literal('result'), downloads: z.array(z.number()), bytes: z.number() })
]);
type Message = z.infer<typeof messageSchema>;

async function main(): Promise<void> {
	const cfg = cfgSchema.parse(process.env);
	const pool = cfg.SOURCE === 'db' ? pgPool(cfg.DOWNLOADERS) : null;
	const random = mulberry32(cfg.SEED + 99);
	await pool?.query('SELECT 1');
	const ready: Message = { type: 'ready' };
	process.send?.(ready);
	const downloads: number[] = [];
	let bytes = 0;
	const deadline = Date.now() + cfg.PHASE_MS;
	const worker = async (): Promise<void> => {
		while (Date.now() < deadline) {
			const id = Math.floor(random() * cfg.FILES) + 1;
			const t = performance.now();
			if (pool) {
				const res = await pool.query('SELECT data FROM attachments_blob WHERE id = $1', [id]);
				bytes += z.object({ data: z.instanceof(Buffer) }).parse(res.rows[0]).data.length;
			} else {
				// await first, then add — writing `bytes += await …` reads bytes' old value before the await,
				// and workers running together wipe out each other's additions (Lesson 5.5's lost update, in JavaScript)
				const data = await getObject(env.BUCKET, `att/${id}`);
				bytes += data?.length ?? 0;
			}
			downloads.push(performance.now() - t);
		}
	};
	await Promise.all(Array.from({ length: cfg.DOWNLOADERS }, worker));
	await pool?.end();
	const result: Message = { type: 'result', downloads, bytes };
	process.send?.(result);
}

// only when run as a forked child (not when where.ts imports it)
if (require.main === module) {
	main().catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}
