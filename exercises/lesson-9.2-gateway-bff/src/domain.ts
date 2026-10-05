import { z } from 'zod';

// Lesson 9.2 — the data of TaskFlow's three services, in memory, from a fixed formula.
// Every service returns its **whole** object — because it has many callers, and it doesn't know who needs what.
// (Settings, notification preferences, checklists, custom fields — the board or mobile app needs most of it not at all.)

const words = [
	'deploy',
	'review',
	'invoice',
	'search',
	'upload',
	'release',
	'fix',
	'check',
	'plan',
	'sync'
];
const text = (seed: number, length: number): string => {
	let out = '';
	for (let i = 0; out.length < length; i++)
		out += `${words[(seed * 7 + i * 3) % words.length] ?? 'x'} `;
	return out.slice(0, length).trim();
};
const iso = (seed: number): string =>
	new Date(Date.UTC(2026, 0, 1) + seed * 3_600_000).toISOString();

export const USERS = 500;
export const TASKS = 2000;
export const COMMENTS_PER_TASK = 20;

export const userSchema = z.object({
	id: z.number(),
	name: z.string(),
	email: z.string(),
	avatar: z.string(),
	timezone: z.string(),
	locale: z.string(),
	bio: z.string(),
	roles: z.array(z.string()),
	notificationSettings: z.record(z.string(), z.boolean()),
	createdAt: z.string(),
	lastSeenAt: z.string()
});
export type User = z.infer<typeof userSchema>;

export const taskSchema = z.object({
	id: z.number(),
	projectId: z.number(),
	title: z.string(),
	description: z.string(),
	status: z.enum(['todo', 'doing', 'done']),
	priority: z.number(),
	assigneeId: z.number(),
	reporterId: z.number(),
	labels: z.array(z.string()),
	checklist: z.array(z.object({ text: z.string(), done: z.boolean() })),
	customFields: z.record(z.string(), z.string()),
	createdAt: z.string(),
	updatedAt: z.string(),
	dueAt: z.string()
});
export type Task = z.infer<typeof taskSchema>;

export const commentSchema = z.object({
	id: z.number(),
	taskId: z.number(),
	authorId: z.number(),
	body: z.string(),
	mentions: z.array(z.number()),
	reactions: z.record(z.string(), z.number()),
	createdAt: z.string(),
	editedAt: z.string().nullable()
});
export type Comment = z.infer<typeof commentSchema>;

export function user(id: number): User | null {
	if (id < 1 || id > USERS) return null;
	return {
		id,
		name: `User ${id}`,
		email: `user${id}@taskflow.test`,
		avatar: `https://cdn.taskflow.test/avatars/${id}.webp`,
		timezone: ['Asia/Dhaka', 'Europe/Berlin', 'America/New_York'][id % 3] ?? 'UTC',
		locale: id % 2 === 0 ? 'bn-BD' : 'en-US',
		bio: text(id, 240),
		roles: id % 10 === 0 ? ['member', 'admin'] : ['member'],
		notificationSettings: Object.fromEntries(
			[
				'assigned',
				'mentioned',
				'commented',
				'due_soon',
				'weekly_digest',
				'status_changed',
				'invited',
				'billing'
			].map((k, i) => [k, (id + i) % 3 !== 0])
		),
		createdAt: iso(id),
		lastSeenAt: iso(id * 13)
	};
}

export function task(id: number): Task | null {
	if (id < 1 || id > TASKS) return null;
	return {
		id,
		projectId: Math.ceil(id / 50),
		title: `Task ${id}: ${text(id, 40)}`,
		description: text(id + 1, 1500),
		status: (['todo', 'doing', 'done'] as const)[id % 3] ?? 'todo',
		priority: id % 4,
		assigneeId: ((id * 37) % USERS) + 1,
		reporterId: ((id * 11) % USERS) + 1,
		labels: [words[id % words.length] ?? 'x', words[(id + 3) % words.length] ?? 'y'],
		checklist: Array.from({ length: 6 }, (_, i) => ({
			text: text(id + i, 50),
			done: (id + i) % 2 === 0
		})),
		customFields: Object.fromEntries(
			Array.from({ length: 6 }, (_, i) => [`field_${i}`, text(id * i, 30)])
		),
		createdAt: iso(id),
		updatedAt: iso(id + 5),
		dueAt: iso(id + 200)
	};
}

export function commentsFor(taskId: number): Comment[] {
	return Array.from({ length: COMMENTS_PER_TASK }, (_, i) => {
		const id = (taskId - 1) * COMMENTS_PER_TASK + i + 1;
		return {
			id,
			taskId,
			authorId: ((id * 53) % USERS) + 1,
			body: text(id, 300),
			mentions: [((id * 7) % USERS) + 1],
			reactions: { '👍': id % 5, '🎉': id % 3 },
			createdAt: iso(taskId + i),
			editedAt: i % 4 === 0 ? iso(taskId + i + 1) : null
		};
	});
}

// The page's shape — what the BFF returns. Web shows more, mobile less.
export type PageComment = {
	id: number;
	body: string;
	at: string;
	author: { name: string; avatar: string };
};
export type TaskPage = {
	id: number;
	title: string;
	description: string;
	status: Task['status'];
	dueAt: string;
	assignee: { name: string; avatar: string } | null;
	comments: PageComment[];
	commentCount: number;
};
