import { z } from 'zod';

// Lesson 9.1 — TaskFlow এর board এর তিনটা অংশ, তিনটা module: tasks, users, comments।
// Data memory তে, একটা নির্দিষ্ট সূত্রে — database নেই, যাতে latency.ts শুধু "function call বনাম network
// call" এর পার্থক্য মাপে, query এর সময় না।
//
// Monolith এ তিনটা module একই process এ, একে অপরকে সরাসরি ডাকে। Microservices এ প্রতিটা আলাদা process,
// আর board বানাতে tasks service বাকি দুটোকে HTTP তে ডাকে। Module এর code দুই ক্ষেত্রেই হুবহু এক —
// পার্থক্য শুধু মাঝের সীমানায়।

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
	comments: number | null; // null = comments এর অংশ এই মুহূর্তে পাওয়া যায়নি (failure.ts এর fallback)
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

// CSV export — "সব comment এর export"। আসল CPU এর কাজ (লাখ লাখ string বানানো আর জোড়া), যেটা event loop
// আটকায় — Lesson 7.1 এর পার্শ্ব নোট। EXPORT_MS এর কাছাকাছি সময় নেয়।
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
