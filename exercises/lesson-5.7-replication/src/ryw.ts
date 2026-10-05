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

// Lesson 5.7 §1.4 — three solutions for read-your-writes, and the price of each.
// The replica is kept 200 ms behind, so the prices are visible.

const DELAY_MS = 200;
const ITERATIONS = 30;

type Strategy = {
	label: string;
	// write a task, then read it back; return whether the read found it
	writeThenRead: () => Promise<{ found: boolean; writeMs: number; readMs: number }>;
};

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
	const started = performance.now();
	const value = await fn();
	return { value, ms: performance.now() - started };
}

const strategies: Strategy[] = [
	{
		label: 'a. nothing (read from the replica)',
		writeThenRead: async () => {
			const w = await timed(() => Task.create({ title: 'naive' }));
			const r = await timed(() => Task.findByPk(w.value.id));
			return { found: r.value !== null, writeMs: w.ms, readMs: r.ms };
		}
	},
	{
		// the read right after your own write goes to the primary — Sequelize's useMaster
		label: 'b. useMaster: true (from the primary)',
		writeThenRead: async () => {
			const w = await timed(() => Task.create({ title: 'use-master' }));
			const r = await timed(() => Task.findByPk(w.value.id, { useMaster: true }));
			return { found: r.value !== null, writeMs: w.ms, readMs: r.ms };
		}
	},
	{
		// after writing, remember the primary's WAL position (LSN); wait until the replica reaches it
		// and then read from the replica. In production this LSN can be given to the client as a token
		// (cookie/header), so that its next request honours it too.
		label: 'c. LSN token — wait for the replica',
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
		// The commit itself waits until the replica applies it (synchronous replication).
		// Only for this transaction — SET LOCAL.
		label: 'd. synchronous_commit = remote_apply',
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
		`\n   replica ${DELAY_MS} ms behind; ${ITERATIONS} times "write → read immediately" for each strategy`
	);
	console.log(`   ${'strategy'.padEnd(42)}    found  write median   read median`);

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
