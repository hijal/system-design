import { z } from 'zod';
import { invalidate, keys, redis } from './cache';

// এই script টা cache এর আসল লাভটা মেপে দেখায় — দাবি না করে, মেপে।
// প্রতিটা "cold" মাপের আগে key টা মুছে দেওয়া হয়, নাহলে আগের run এর
// গরম cache ই মাপা হবে আর সংখ্যাটা মিথ্যা হবে।
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const USER_ID = 7;
const ROUNDS = 20;

const responseSchema = z.object({
	tasks: z.array(z.unknown()),
	source: z.union([z.literal('cache'), z.literal('database')]),
	tookMs: z.number()
});

async function measure(
	url: string
): Promise<{ source: 'cache' | 'database'; tookMs: number; count: number }> {
	const res = await fetch(url);
	const body: unknown = await res.json();
	const parsed = responseSchema.parse(body);
	return { source: parsed.source, tookMs: parsed.tookMs, count: parsed.tasks.length };
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function main(): Promise<void> {
	const url = `${BASE}/api/tasks?userId=${USER_ID}`;
	const key = keys.tasksByUser(USER_ID);

	// ---- MISS: প্রতিবার key মুছে, তাই প্রতিটাই সত্যিকারের DB hit ----
	const cold: number[] = [];
	let count = 0;
	for (let i = 0; i < ROUNDS; i++) {
		await invalidate(key);
		const sample = await measure(url);
		if (sample.source !== 'database') throw new Error('expected a cache MISS after invalidate');
		cold.push(sample.tookMs);
		count = sample.count;
	}

	// ---- HIT: key এখন গরম, তাই সব cache থেকে ----
	const warm: number[] = [];
	let hits = 0;
	for (let i = 0; i < ROUNDS; i++) {
		const sample = await measure(url);
		if (sample.source === 'cache') hits++;
		warm.push(sample.tookMs);
	}

	const coldMedian = median(cold);
	const warmMedian = median(warm);

	console.log(`\n  dataset        : ${count} tasks`);
	console.log(`  MISS (DB)  x${ROUNDS} : median ${coldMedian.toFixed(2)} ms`);
	console.log(`  HIT (cache) x${ROUNDS} : median ${warmMedian.toFixed(2)} ms`);
	console.log(`  cache hits     : ${hits}/${ROUNDS}`);
	console.log(`  speedup        : ~${(coldMedian / Math.max(warmMedian, 0.001)).toFixed(1)}x\n`);

	await redis.quit();
}

main().catch((error: unknown): void => {
	console.error('bench failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
