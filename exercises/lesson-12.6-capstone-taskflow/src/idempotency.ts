import { createApp } from './app';
import { resetDatabase, sequelize, Task } from './db';
import { chance, close, env, heading, http, listen, n, row } from './util';

const REQUESTS = env('REQUESTS', 1_000);
const LOST = env('LOST', 0.1);
const PAIRS = env('PAIRS', 100);
const SEED = env('SEED', 7);

type Line = { label: string; sent: number; tasks: number; duplicates: number; replayed: number };

async function retries(base: string, withKey: boolean): Promise<Line> {
	await resetDatabase();
	let sent = 0;
	let replayed = 0;
	for (let i = 1; i <= REQUESTS; i++) {
		const headers: Record<string, string> = withKey
			? { 'Idempotency-Key': `create-${SEED}-${i}` }
			: {};
		const body = { title: `task ${i}` };
		sent++;
		await http(base, 'POST', '/boards/1/tasks', body, headers);
		if (chance(i, SEED, LOST)) {
			sent++;
			const retry = await http(base, 'POST', '/boards/1/tasks', body, headers);
			if (retry.headers.get('Idempotent-Replayed') === 'true') replayed++;
		}
	}
	const tasks = await Task.count();
	return {
		label: withKey ? 'retry with the same Idempotency-Key' : 'retry without a key',
		sent,
		tasks,
		duplicates: tasks - REQUESTS,
		replayed
	};
}

async function main(): Promise<void> {
	const { server, base } = await listen(createApp({ naiveRoute: false }));

	heading(
		`Part A — ${n(REQUESTS)} creates; ${(LOST * 100).toFixed(0)}% of responses are lost on the way back, the client retries`
	);
	const lines = [await retries(base, false), await retries(base, true)];
	console.log(
		row([
			['client', 40],
			['requests', 10],
			['tasks', 8],
			['duplicates', 12],
			['replayed', 10]
		])
	);
	for (const line of lines) {
		console.log(
			row([
				[line.label, 40],
				[n(line.sent), 10],
				[n(line.tasks), 8],
				[n(line.duplicates), 12],
				[n(line.replayed), 10]
			])
		);
	}

	heading(`Part B — ${PAIRS} pairs: the retry fires while the first request is still running`);
	await resetDatabase();
	const pairs = await Promise.all(
		Array.from({ length: PAIRS }, (_, index) => {
			const headers = { 'Idempotency-Key': `pair-${SEED}-${index}` };
			const body = { title: `pair ${index}` };
			return Promise.all([
				http(base, 'POST', '/boards/2/tasks', body, headers),
				http(base, 'POST', '/boards/2/tasks', body, headers)
			]);
		})
	);
	const responses = pairs.flat();
	const created = responses.filter((r) => r.status === 201).length;
	const replays = responses.filter((r) => r.headers.get('Idempotent-Replayed') === 'true').length;
	console.log(
		`responses 201: ${created}/${responses.length} · replayed: ${replays} · tasks in the database: ${await Task.count()}`
	);

	heading('Part C — the same key with a different body');
	const reuse = await http(
		base,
		'POST',
		'/boards/2/tasks',
		{ title: 'something else' },
		{
			'Idempotency-Key': `pair-${SEED}-0`
		}
	);
	console.log(
		`status ${reuse.status} — a key belongs to one request; reusing it for another is a client bug`
	);

	await close(server);
	await sequelize.close();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
