import { createApp } from './app';
import { Notification, OutboxEvent, resetDatabase, sequelize, Task } from './db';
import type { TaskEvent } from './events';
import {
	connect,
	createQueue,
	relayUntilEmpty,
	startWorker,
	waitForQueue,
	type Hooks
} from './pipeline';
import { FakeEmailProvider } from './provider';
import { z } from 'zod';
import { close, http, listen } from './util';

const taskBody = z.object({ id: z.number(), version: z.number(), column: z.string() });
const conflictBody = z.object({ current: taskBody });

const QUEUE = 'capstone-smoke';

async function main(): Promise<void> {
	await resetDatabase();
	const connection = connect();
	const queue = createQueue(QUEUE, connection);
	await queue.obliterate({ force: true });
	const provider = new FakeEmailProvider();

	const crashedRelay = new Set<string>();
	const crashedWorker = new Set<string>();
	let crashRelayFor: number | null = null;
	let crashWorkerFor: number | null = null;
	const hooks: Hooks = {
		crashAfterEnqueue: (event: TaskEvent) => {
			if (event.taskId !== crashRelayFor || event.type !== 'task.assigned') return false;
			if (crashedRelay.has(event.eventId)) return false;
			crashedRelay.add(event.eventId);
			return true;
		},
		crashAfterSend: (event: TaskEvent) => {
			if (event.taskId !== crashWorkerFor || crashedWorker.has(event.eventId)) return false;
			crashedWorker.add(event.eventId);
			return true;
		}
	};
	const worker = startWorker(QUEUE, connection, provider, hooks);
	const { server, base } = await listen(createApp({ naiveRoute: false }));

	const lines: [string, string][] = [];
	const step = (label: string, result: string): void => {
		lines.push([label, result]);
	};
	const flush = async (): Promise<number> => {
		const crashes = await relayUntilEmpty(queue, hooks);
		await waitForQueue(queue);
		return crashes;
	};
	const key = { 'Idempotency-Key': 'create-7f3a9c21' };

	const first = await http(base, 'POST', '/boards/1/tasks', { title: 'Write the design doc' }, key);
	const created = taskBody.parse(first.body);
	step(
		'create a task with an Idempotency-Key',
		`${first.status} task ${created.id}, version ${created.version}`
	);

	const again = await http(base, 'POST', '/boards/1/tasks', { title: 'Write the design doc' }, key);
	const replayed = taskBody.parse(again.body);
	step(
		'the same key again (a client retry)',
		`${again.status} task ${replayed.id}, replayed=${again.headers.get('Idempotent-Replayed') ?? 'false'}; tasks ${await Task.count()}`
	);

	const mismatch = await http(base, 'POST', '/boards/1/tasks', { title: 'Something else' }, key);
	step('the same key, a different body', `${mismatch.status}`);

	const moved = await http(base, 'PATCH', `/tasks/${created.id}`, { version: 1, column: 'doing' });
	step(
		'move to doing with version 1',
		`${moved.status} version ${taskBody.parse(moved.body).version}`
	);

	const stale = await http(base, 'PATCH', `/tasks/${created.id}`, { version: 1, column: 'done' });
	const staleBody = conflictBody.parse(stale.body);
	step(
		'move again with the stale version 1',
		`${stale.status} current is version ${staleBody.current.version} in ${staleBody.current.column}`
	);

	crashRelayFor = created.id;
	crashWorkerFor = created.id;
	const assigned = await http(base, 'PATCH', `/tasks/${created.id}`, {
		version: 2,
		assigneeId: 'u_rina'
	});
	step(
		'assign to u_rina with version 2',
		`${assigned.status} version ${taskBody.parse(assigned.body).version}`
	);
	const relayCrashes = await flush();
	step(
		'relay: crash after enqueue, then retry',
		`${relayCrashes} crash, the batch rolled back and was sent again`
	);
	step(
		'worker: crash after the email, then retry',
		`provider calls ${provider.calls}, duplicates absorbed ${provider.duplicateCalls}`
	);
	step(
		'emails delivered to u_rina',
		`${[...provider.delivered.values()].filter((email) => email.to === 'u_rina').length}`
	);

	const unpublished = await OutboxEvent.count({ where: { publishedAt: null } });
	const events = await OutboxEvent.count();
	const notifications = await Notification.count({ where: { status: 'sent' } });
	step('the outbox at the end', `${events} events, ${unpublished} unpublished`);
	step('notifications marked sent', `${notifications}`);

	console.log(`${'#'.padEnd(4)}${'step'.padEnd(46)}result`);
	lines.forEach(([label, result], index) => {
		console.log(`${String(index + 1).padEnd(4)}${label.padEnd(46)}${result}`);
	});

	await close(server);
	await worker.close();
	await queue.close();
	connection.disconnect();
	await sequelize.close();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
