import { performance } from 'node:perf_hooks';
import { Task, app, closeAll, replica, setApplyDelay, sleep, waitForCatchUp } from './db';

// Lesson 5.7 §১.৩ — TaskFlow এর "এইমাত্র save করলাম, কিন্তু দেখাচ্ছে না!" bug।
// Task.create → primary এ যায়। ঠিক পরের Task.findByPk → Sequelize replica তে পাঠায়।

function percentile(sorted: number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

// Replica তে row টা দেখা যাওয়া পর্যন্ত কত সময় — এটাই replication lag, মাপা
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
		const readBack = await Task.findByPk(created.id); // → replica (Sequelize নিজে থেকে)
		if (readBack === null) stale++;
		lags.push(await visibleAfter(created.id, started));
	}
	lags.sort((a, b) => a - b);
	console.log(
		`   ${label.padEnd(34)} ${String(stale).padStart(4)}/${iterations}   p50 ${percentile(lags, 50).toFixed(1).padStart(6)} ms   p99 ${percentile(lags, 99).toFixed(1).padStart(6)} ms`
	);
}

async function main(): Promise<void> {
	await app.sync({ force: true }); // primary তে table — replica তে WAL দিয়ে নিজেই পৌঁছায়
	await waitForCatchUp();

	console.log('\n   create (primary) → সাথে সাথে findByPk (replica)');
	console.log(`   ${'অবস্থা'.padEnd(34)}  খুঁজে পায়নি   replica তে দেখা যেতে কত সময় লাগল`);
	await run('স্বাভাবিক (একই মেশিন, load নেই)', 0, 200);
	await run('replica ২০০ ms পিছিয়ে (নকল lag)', 200, 50);

	await setApplyDelay(0);
	console.log('');
	await closeAll();
}

main().catch(async (error: unknown): Promise<void> => {
	console.error('lag failed:', error instanceof Error ? error.message : String(error));
	await closeAll();
	process.exit(1);
});
