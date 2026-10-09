import { z } from 'zod';
import { createApp } from './app';
import { Notification, resetDatabase, sequelize, Task } from './db';
import { connect, createQueue, relayUntilEmpty, startWorker, waitForQueue } from './pipeline';
import { FakeEmailProvider } from './provider';
import { close, env, heading, http, listen, row } from './util';

const CLIENTS = env('CLIENTS', 50);
const QUEUE = 'capstone-concurrency';

const taskBody = z.object({
	id: z.number(),
	version: z.number(),
	assigneeId: z.string().nullable()
});

type Outcome = {
	label: string;
	ok: number;
	conflicts: number;
	overwritten: number;
	emails: number;
	wrongEmails: number;
	finalAssignee: string;
};

async function race(base: string, path: string, label: string): Promise<Outcome> {
	await resetDatabase();
	const createdResponse = await http(base, 'POST', '/boards/1/tasks', {
		title: 'Fix the login bug'
	});
	const created = taskBody.parse(createdResponse.body);
	const results = await Promise.all(
		Array.from({ length: CLIENTS }, (_, index) =>
			http(base, 'PATCH', `${path}/${created.id}`, {
				version: created.version,
				assigneeId: `u${index + 1}`
			})
		)
	);
	const ok = results.filter((result) => result.status === 200).length;
	const conflicts = results.filter((result) => result.status === 409).length;
	const final = await Task.findByPk(created.id);
	const finalAssignee = final?.assigneeId ?? 'nobody';
	return {
		label,
		ok,
		conflicts,
		overwritten: Math.max(0, ok - 1),
		emails: 0,
		wrongEmails: 0,
		finalAssignee
	};
}

async function main(): Promise<void> {
	const connection = connect();
	const queue = createQueue(QUEUE, connection);
	await queue.obliterate({ force: true });
	const provider = new FakeEmailProvider();
	const worker = startWorker(QUEUE, connection, provider);
	const { server, base } = await listen(createApp({ naiveRoute: true }));

	const outcomes: Outcome[] = [];
	for (const [path, label] of [
		['/naive/tasks', 'read, then write (no version check)'],
		['/tasks', 'optimistic lock (WHERE version = ?)']
	] as const) {
		provider.reset();
		const outcome = await race(base, path, label);
		await relayUntilEmpty(queue);
		await waitForQueue(queue);
		const delivered = [...provider.delivered.values()];
		outcome.emails = delivered.length;
		outcome.wrongEmails = delivered.filter((email) => email.to !== outcome.finalAssignee).length;
		outcomes.push(outcome);
		await Notification.destroy({ where: {} });
	}

	heading(`${CLIENTS} people assign the same task at the same moment, each to a different user`);
	console.log(
		row([
			['strategy', 40],
			['200', 6],
			['409', 6],
			['silently lost', 15],
			['emails', 8],
			['to the wrong person', 21]
		])
	);
	for (const outcome of outcomes) {
		console.log(
			row([
				[outcome.label, 40],
				[outcome.ok, 6],
				[outcome.conflicts, 6],
				[outcome.overwritten, 15],
				[outcome.emails, 8],
				[outcome.wrongEmails, 21]
			])
		);
	}
	console.log(
		'"silently lost": got 200 but the task is not assigned to their choice. A 409 is not lost - the client is told and can re-read.'
	);

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
