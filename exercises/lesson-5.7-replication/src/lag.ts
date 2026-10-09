import { performance } from 'node:perf_hooks';
import { Task, app, closeAll, replica, setApplyDelay, sleep, waitForCatchUp } from './db';

// Lesson 5.7 §1.3 - TaskFlow's "I just saved it, but it doesn't show!" bug.
// Task.create → goes to the primary. The very next Task.findByPk → Sequelize sends it to the replica.

function percentile(sorted: number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

// How long until the row is visible on the replica - this is the replication lag, measured
async function visibleAfter(id: number, started: number): Promise<number> {
	for (;;) {
		const found = await replica.query('SELECT 1 FROM tasks WHERE id = :id', {
			replacements: { id },
			plain: true
		});
		if (found) return performance.now() - started;
		await sleep(1);
	}
}

async function run(label: string, delayMs: number, iterations: number): Promise<void> {
	await setApplyDelay(delayMs);
	await waitForCatchUp();

	let stale = 0;
	const lags: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const created = await Task.create({ title: `task ${i}` }); // → primary
		const started = performance.now();
		const readBack = await Task.findByPk(created.id); // → replica (Sequelize does it by itself)
		if (readBack === null) stale++;
		lags.push(await visibleAfter(created.id, started));
	}
	lags.sort((a, b) => a - b);
	console.log(
		`   ${label.padEnd(38)} ${String(stale).padStart(4)}/${iterations}   p50 ${percentile(lags, 50).toFixed(1).padStart(6)} ms   p99 ${percentile(lags, 99).toFixed(1).padStart(6)} ms`
	);
}

async function main(): Promise<void> {
	await app.sync({ force: true }); // the table on the primary - it reaches the replica through WAL by itself
	await waitForCatchUp();

	console.log('\n   create (primary) → findByPk right away (replica)');
	console.log(`   ${'situation'.padEnd(38)}  not found   time until visible on the replica`);
	await run('normal (same machine, no load)', 0, 200);
	await run('replica 200 ms behind (simulated lag)', 200, 50);

	await setApplyDelay(0);
	console.log('');
	await closeAll();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('lag failed:', error instanceof Error ? error.message : String(error));
	await closeAll();
	process.exit(1);
});
