import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { resetDatabase, sequelize, Task } from './db';
import type { TaskEvent } from './events';
import {
	connect,
	createQueue,
	relayUntilEmpty,
	SimulatedCrash,
	startWorker,
	waitForQueue,
	type Hooks
} from './pipeline';
import { FakeEmailProvider } from './provider';
import { createTask } from './tasks';
import { chance, env, heading, n, row } from './util';

const TASKS = env('TASKS', 1_000);
const CRASH = env('CRASH', 0.02);
const SEED = env('SEED', 11);

type Line = {
	label: string;
	tasks: number;
	emails: number;
	lost: number;
	phantom: number;
	crashes: number;
	providerCalls: number;
};

const input = (i: number): { boardId: number; title: string; assigneeId: string } => ({
	boardId: 1,
	title: `task ${i}`,
	assigneeId: `u${(i % 40) + 1}`
});

const assignedEvent = (task: Task): TaskEvent => ({
	type: 'task.assigned',
	eventId: randomUUID(),
	taskId: task.id,
	assigneeId: task.assigneeId ?? 'nobody',
	title: task.title
});

async function commitThenEnqueue(queue: Queue): Promise<number> {
	let crashes = 0;
	for (let i = 1; i <= TASKS; i++) {
		const task = await sequelize.transaction((transaction) =>
			Task.create({ ...input(i), column: 'todo', position: i }, { transaction })
		);
		if (chance(i, SEED, CRASH)) {
			crashes++;
			continue;
		}
		const event = assignedEvent(task);
		await queue.add(event.type, event, { jobId: event.eventId });
	}
	return crashes;
}

async function enqueueThenCommit(queue: Queue): Promise<number> {
	let crashes = 0;
	for (let i = 1; i <= TASKS; i++) {
		try {
			await sequelize.transaction(async (transaction) => {
				const task = await Task.create(
					{ ...input(i), column: 'todo', position: i },
					{ transaction }
				);
				const event = assignedEvent(task);
				await queue.add(event.type, event, { jobId: event.eventId });
				if (chance(i, SEED, CRASH)) throw new SimulatedCrash('before commit');
			});
		} catch (error: unknown) {
			if (!(error instanceof SimulatedCrash)) throw error;
			crashes++;
		}
	}
	return crashes;
}

async function outbox(queue: Queue, hooks: Hooks): Promise<number> {
	for (let i = 1; i <= TASKS; i++) await createTask(input(i), undefined);
	return relayUntilEmpty(queue, hooks);
}

async function measure(
	label: string,
	queue: Queue,
	provider: FakeEmailProvider,
	run: () => Promise<number>
): Promise<Line> {
	await resetDatabase();
	provider.reset();
	const crashes = await run();
	await waitForQueue(queue);
	const tasks = await Task.findAll({ attributes: ['id'] });
	const ids = new Set(tasks.map((task) => task.id));
	const delivered = [...provider.delivered.values()];
	const emailed = new Set(delivered.map((email) => email.taskId));
	return {
		label,
		tasks: tasks.length,
		emails: delivered.length,
		lost: tasks.filter((task) => !emailed.has(task.id)).length,
		phantom: delivered.filter((email) => !ids.has(email.taskId)).length,
		crashes,
		providerCalls: provider.calls
	};
}

async function main(): Promise<void> {
	const connection = connect();
	const queue = createQueue('capstone-crash', connection);
	await queue.obliterate({ force: true });
	const provider = new FakeEmailProvider();

	const relayCrashed = new Set<string>();
	const workerCrashed = new Set<string>();
	let workerChaos = false;
	const hooks: Hooks = {
		crashAfterEnqueue: (event) => {
			if (event.type !== 'task.assigned') return false;
			if (relayCrashed.has(event.eventId) || !chance(event.taskId, SEED, CRASH)) return false;
			relayCrashed.add(event.eventId);
			return true;
		},
		crashAfterSend: (event) => {
			if (!workerChaos) return false;
			if (workerCrashed.has(event.eventId) || !chance(event.taskId, SEED + 1, CRASH)) return false;
			workerCrashed.add(event.eventId);
			return true;
		}
	};
	const worker = startWorker('capstone-crash', connection, provider, hooks);

	const lines = [
		await measure('commit, then enqueue', queue, provider, () => commitThenEnqueue(queue)),
		await measure('enqueue, then commit', queue, provider, () => enqueueThenCommit(queue)),
		await measure('outbox in the same transaction', queue, provider, () => {
			workerChaos = true;
			return outbox(queue, hooks);
		})
	];

	heading(
		`${n(TASKS)} tasks created with an assignee; a crash at ${(CRASH * 100).toFixed(0)}% of the risky points`
	);
	console.log(
		row([
			['write order', 34],
			['tasks', 8],
			['emails', 8],
			['no email', 10],
			['email, no task', 16],
			['crashes', 9]
		])
	);
	for (const line of lines) {
		console.log(
			row([
				[line.label, 34],
				[n(line.tasks), 8],
				[n(line.emails), 8],
				[n(line.lost), 10],
				[n(line.phantom), 16],
				[n(line.crashes), 9]
			])
		);
	}
	const outboxLine = lines[2];
	if (outboxLine !== undefined) {
		console.log(
			`outbox, on top of the relay crashes: ${workerCrashed.size} worker crashes after sending the email; provider calls ${n(outboxLine.providerCalls)} for ${n(outboxLine.emails)} emails — the provider's idempotency key absorbed the repeats`
		);
	}

	await worker.close();
	await queue.close();
	connection.disconnect();
	await sequelize.close();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
