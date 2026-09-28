import { type ChildProcess, fork } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

// Service process চালানো, থামানো, আর তাদের CPU এর হিসাব। প্রতিটা process আলাদা Node — নিজের event loop,
// নিজের memory — যেমন আসল deploy এ আলাদা container।

const readySchema = z.object({ type: z.literal('ready'), port: z.number() });
const cpuSchema = z.object({ type: z.literal('cpu'), micros: z.number() });

export type Proc = { name: string; url: string; child: ChildProcess };

export function start(name: string, env: Record<string, string>): Promise<Proc> {
	const child = fork(path.join(__dirname, 'service.js'), [], {
		env: { ...process.env, ...env },
		stdio: ['ignore', 'inherit', 'inherit', 'ipc']
	});
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.on('message', function onReady(msg: unknown) {
			const ready = readySchema.safeParse(msg);
			if (!ready.success) return;
			child.off('message', onReady);
			resolve({ name, url: `http://127.0.0.1:${ready.data.port}`, child });
		});
	});
}

export function stop(proc: Proc): Promise<void> {
	if (proc.child.exitCode !== null || proc.child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		proc.child.once('exit', () => resolve());
		proc.child.kill('SIGKILL'); // crash এর মতো — graceful shutdown না
	});
}

export function cpuMicros(proc: Proc): Promise<number> {
	return new Promise((resolve) => {
		proc.child.on('message', function onCpu(msg: unknown) {
			const cpu = cpuSchema.safeParse(msg);
			if (!cpu.success) return;
			proc.child.off('message', onCpu);
			resolve(cpu.data.micros);
		});
		proc.child.send('cpu');
	});
}

export async function totalCpuMicros(procs: Proc[]): Promise<number> {
	const all = await Promise.all(procs.map(cpuMicros));
	return all.reduce((a, b) => a + b, 0);
}

export type Topology = { entry: Proc; procs: Proc[] };

// monolith: একটা process। microservices: users, comments, আর tasks (board এর route) — tasks বাকি দুটোর URL জানে
export async function monolith(extra: Record<string, string> = {}): Promise<Topology> {
	const entry = await start('monolith', { ROLE: 'monolith', ...extra });
	return { entry, procs: [entry] };
}

export async function microservices(
	tasksEnv: Record<string, string>,
	extra: Record<string, string> = {}
): Promise<Topology & { users: Proc; comments: Proc }> {
	const users = await start('users', { ROLE: 'users', ...extra });
	const comments = await start('comments', { ROLE: 'comments', ...extra });
	const entry = await start('tasks', {
		ROLE: 'tasks',
		USERS_URL: users.url,
		COMMENTS_URL: comments.url,
		...extra,
		...tasksEnv
	});
	return { entry, procs: [entry, users, comments], users, comments };
}

export async function stopAll(topology: Topology): Promise<void> {
	await Promise.all(topology.procs.map(stop));
}
