import { z } from 'zod';
import { env, getObject, pgPool } from './storage';
import { mulberry32 } from './random';

// Lesson 8.1 — where.ts এর child process: app এর বাইরে থেকে file নামানো।
//   SOURCE=s3 — browser/CDN যেভাবে object storage থেকে সরাসরি নামায় (8.2 এর presigned URL); app ছোঁয় না
//   SOURCE=db — Postgres থেকে, কিন্তু app এর process আর pool এর বাইরে — শুধু database এর উপর চাপ মাপতে
// আলাদা process কারণ: একই Node process এ হলে file এর byte টানার CPU OLTP এর latency তেও ঢুকত।

const cfgSchema = z.object({
	SOURCE: z.enum(['db', 's3']),
	PHASE_MS: z.coerce.number().int().positive(),
	DOWNLOADERS: z.coerce.number().int().positive(),
	FILES: z.coerce.number().int().positive(),
	SEED: z.coerce.number().int()
});

// child → parent: আগে 'ready' (connection তৈরি, মাপা শুরু), শেষে ফল
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
				// আগে await, তারপর যোগ — `bytes += await …` লিখলে bytes এর পুরনো মান await এর আগেই পড়া হয়,
				// আর একসাথে চলা worker রা একে অপরের যোগ মুছে দেয় (Lesson 5.5 এর lost update, JavaScript এ)
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

// শুধু fork করা child হিসেবে চললে (where.ts import করলে না)
if (require.main === module) {
	main().catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}
