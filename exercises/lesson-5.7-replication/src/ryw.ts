import { performance } from 'node:perf_hooks';
import {
	Task,
	app,
	closeAll,
	primary,
	scalarText,
	setApplyDelay,
	waitForCatchUp,
	waitForReplay
} from './db';

// Lesson 5.7 §১.৪ — read-your-writes এর তিনটা সমাধান, আর প্রতিটার দাম।
// Replica কে ২০০ ms পিছিয়ে রাখা, যাতে দাম গুলো চোখে পড়ে।

const DELAY_MS = 200;
const ITERATIONS = 30;

type Strategy = {
	label: string;
	// একটা task লেখো, তারপর পড়ে দেখো; পড়ায় পাওয়া গেল কিনা ফেরত দাও
	writeThenRead: () => Promise<{ found: boolean; writeMs: number; readMs: number }>;
};

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
	const started = performance.now();
	const value = await fn();
	return { value, ms: performance.now() - started };
}

const strategies: Strategy[] = [
	{
		label: 'ক. কিছু না (replica থেকে পড়া)',
		writeThenRead: async () => {
			const w = await timed(() => Task.create({ title: 'naive' }));
			const r = await timed(() => Task.findByPk(w.value.id));
			return { found: r.value !== null, writeMs: w.ms, readMs: r.ms };
		}
	},
	{
		// নিজের লেখার ঠিক পরের পড়া primary থেকে — Sequelize এর useMaster
		label: 'খ. useMaster: true (primary থেকে)',
		writeThenRead: async () => {
			const w = await timed(() => Task.create({ title: 'use-master' }));
			const r = await timed(() => Task.findByPk(w.value.id, { useMaster: true }));
			return { found: r.value !== null, writeMs: w.ms, readMs: r.ms };
		}
	},
	{
		// লেখার পর primary এর WAL অবস্থান (LSN) মনে রাখো; replica সেখানে পৌঁছানো পর্যন্ত
		// অপেক্ষা করে তারপর replica থেকে পড়ো। Production এ এই LSN টা একটা token হিসেবে
		// client কে দেওয়া যায় (cookie/header), যাতে তার পরের request ও এটা মানে।
		label: 'গ. LSN token — replica ধরা পর্যন্ত অপেক্ষা',
		writeThenRead: async () => {
			const w = await timed(async () => {
				const task = await Task.create({ title: 'lsn-wait' });
				const lsn = await scalarText(primary, 'SELECT pg_current_wal_lsn()::text AS v');
				return { task, lsn };
			});
			const r = await timed(async () => {
				await waitForReplay(w.value.lsn);
				return Task.findByPk(w.value.task.id);
			});
			return { found: r.value !== null, writeMs: w.ms, readMs: r.ms };
		}
	},
	{
		// Commit নিজেই অপেক্ষা করে যতক্ষণ না replica এটা প্রয়োগ করে (synchronous replication)।
		// শুধু এই transaction এর জন্য — SET LOCAL।
		label: 'ঘ. synchronous_commit = remote_apply',
		writeThenRead: async () => {
			const w = await timed(() =>
				app.transaction(async (transaction) => {
					await app.query('SET LOCAL synchronous_commit = remote_apply', { transaction });
					return Task.create({ title: 'remote-apply' }, { transaction });
				})
			);
			const r = await timed(() => Task.findByPk(w.value.id));
			return { found: r.value !== null, writeMs: w.ms, readMs: r.ms };
		}
	}
];

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function main(): Promise<void> {
	await app.sync({ force: true });
	await setApplyDelay(DELAY_MS);
	console.log(
		`\n   replica ${DELAY_MS} ms পিছিয়ে; প্রতিটা কৌশলে ${ITERATIONS} বার "লেখো → সাথে সাথে পড়ো"`
	);
	console.log(`   ${'কৌশল'.padEnd(42)} পাওয়া গেছে   লেখা (median)   পড়া (median)`);

	for (const strategy of strategies) {
		await waitForCatchUp();
		let found = 0;
		const writes: number[] = [];
		const reads: number[] = [];
		for (let i = 0; i < ITERATIONS; i++) {
			const result = await strategy.writeThenRead();
			if (result.found) found++;
			writes.push(result.writeMs);
			reads.push(result.readMs);
		}
		console.log(
			`   ${strategy.label.padEnd(42)} ${String(found).padStart(4)}/${ITERATIONS}   ${median(writes).toFixed(1).padStart(8)} ms   ${median(reads).toFixed(1).padStart(8)} ms`
		);
	}

	await setApplyDelay(0);
	console.log('');
	await closeAll();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('ryw failed:', error instanceof Error ? error.message : String(error));
	await setApplyDelay(0).catch(() => undefined);
	await closeAll();
	process.exit(1);
});
