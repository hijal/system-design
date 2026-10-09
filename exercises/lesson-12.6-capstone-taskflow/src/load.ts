import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { createApp } from './app';
import { OutboxEvent, resetDatabase, sequelize } from './db';
import { close, env, heading, http, listen, n, percentile } from './util';

const CLIENTS = env('CLIENTS', 20);
const DURATION_S = env('DURATION_S', 10);
const ESTIMATED_PEAK = env('ESTIMATED_PEAK', 90);

const taskBody = z.object({ id: z.number(), version: z.number() });
const columns = ['todo', 'doing', 'done'] as const;

async function main(): Promise<void> {
	await resetDatabase();
	const { server, base } = await listen(createApp({ naiveRoute: false }));

	const tasks = await Promise.all(
		Array.from({ length: CLIENTS }, async (_, index) =>
			taskBody.parse((await http(base, 'POST', '/boards/1/tasks', { title: `load ${index}` })).body)
		)
	);

	const latencies: number[] = [];
	let conflicts = 0;
	const deadline = performance.now() + DURATION_S * 1_000;
	await Promise.all(
		tasks.map(async (task) => {
			let version = task.version;
			let step = 0;
			while (performance.now() < deadline) {
				step++;
				const started = performance.now();
				const result = await http(base, 'PATCH', `/tasks/${task.id}`, {
					version,
					column: columns[step % columns.length],
					position: step
				});
				latencies.push(performance.now() - started);
				if (result.status === 200) version = taskBody.parse(result.body).version;
				else conflicts++;
			}
		})
	);

	latencies.sort((a, b) => a - b);
	const throughput = latencies.length / DURATION_S;
	heading(
		`${CLIENTS} clients moving their own tasks for ${DURATION_S} s - each move: read, conditional UPDATE, outbox INSERT, one transaction`
	);
	console.log(`moves                 ${n(latencies.length)}  (${conflicts} conflicts)`);
	console.log(`throughput            ${n(throughput)} moves/s`);
	console.log(
		`latency               p50 ${percentile(latencies, 50).toFixed(1)} ms · p99 ${percentile(latencies, 99).toFixed(1)} ms`
	);
	console.log(`outbox rows written   ${n(await OutboxEvent.count())}`);
	console.log(
		`against the design doc's estimated peak of ~${ESTIMATED_PEAK} writes/s: ${(throughput / ESTIMATED_PEAK).toFixed(0)}× headroom on this machine`
	);
	console.log(
		'machine-dependent: a laptop, Postgres in Docker, the client in the same process. Measure on your own hardware.'
	);

	await close(server);
	await sequelize.close();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
