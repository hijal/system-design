import { z } from 'zod';

// Lesson 9.1 — the three parts of TaskFlow's board, three modules: tasks, users, comments.
// The data is in memory, from a fixed formula — no database, so latency.ts measures only the "function call vs network
// call" difference, not query time.
//
// In the monolith the three modules are in the same process and call each other directly. In microservices each is a separate process,
// and to build the board the tasks service calls the other two over HTTP. The modules' code is exactly the same in both —
// the only difference is the boundary in between.

export const PROJECTS = 40;
export const TASKS_PER_PROJECT = 50;
export const USERS = 200;

export const userSchema = z.object({ id: z.number(), name: z.string(), avatar: z.string() });
export type User = z.infer<typeof userSchema>;

export type Task = { id: number; projectId: number; title: string; assigneeId: number };

export type BoardCard = {
	id: number;
	title: string;
	assignee: User | null;
	comments: number | null; // null = the comments part couldn't be reached at this moment (failure.ts's fallback)
};
export type Board = { projectId: number; cards: BoardCard[]; degraded: boolean };

// ── tasks module ──
const tasks: Task[] = Array.from({ length: PROJECTS * TASKS_PER_PROJECT }, (_, i) => ({
	id: i + 1,
	projectId: Math.floor(i / TASKS_PER_PROJECT) + 1,
	title: `Task ${i + 1}: ship the ${['login', 'invoice', 'search', 'upload'][i % 4] ?? 'thing'} change`,
	assigneeId: ((i * 37) % USERS) + 1
}));
export function tasksForProject(projectId: number): Task[] {
	return tasks.filter((t) => t.projectId === projectId);
}

// ── users module ──
const users = new Map<number, User>(
	Array.from({ length: USERS }, (_, i) => [
		i + 1,
		{ id: i + 1, name: `User ${i + 1}`, avatar: `https://cdn.taskflow.test/avatars/${i + 1}.webp` }
	])
);
export function getUser(id: number): User | null {
	return users.get(id) ?? null;
}

// ── comments module ──
export function commentCount(taskId: number): number {
	return (taskId * 7919) % 23;
}

// CSV export — "export every comment". Real CPU work (building and joining millions of strings), which blocks the event
// loop — Lesson 7.1's side note. Takes about EXPORT_MS.
export function exportComments(targetMs: number): number {
	const start = performance.now();
	let bytes = 0;
	while (performance.now() - start < targetMs) {
		const rows: string[] = [];
		for (let i = 0; i < 2000; i++) rows.push(`${i},"comment ${i} on task ${i % 97}",${i * 3}`);
		bytes += rows.join('\n').length;
	}
	return bytes;
}
