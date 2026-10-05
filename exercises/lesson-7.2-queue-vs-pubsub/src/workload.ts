import { uniform } from './random';

// TaskFlow's event stream: every task is created, assigned, gets a few comments, then completed.
// The events of the same task have an order (seq) — "assigned" should be processed before "completed".

export type EventType = 'task.created' | 'task.assigned' | 'comment.created' | 'task.completed';

export interface TaskEvent {
	id: number;
	taskId: number;
	seq: number;
	type: EventType;
	publishedAt: number;
}

export function generateEvents(
	random: () => number,
	durationMs: number,
	tasksPerSecond: number
): TaskEvent[] {
	const raw: Omit<TaskEvent, 'id'>[] = [];
	let t = 0;
	let taskId = 0;
	for (;;) {
		t += -Math.log(1 - random()) * (1000 / tasksPerSecond);
		if (t >= durationMs) break;
		taskId++;
		const types: EventType[] = ['task.created', 'task.assigned'];
		const comments = Math.floor(random() * 4);
		for (let i = 0; i < comments; i++) types.push('comment.created');
		types.push('task.completed');
		let at = t;
		types.forEach((type, seq) => {
			if (seq > 0) at += uniform(random, 50, 1500);
			if (at < durationMs) raw.push({ taskId, seq, type, publishedAt: Math.round(at) });
		});
	}
	raw.sort((a, b) => a.publishedAt - b.publishedAt || a.taskId - b.taskId || a.seq - b.seq);
	return raw.map((event, id) => ({ id, ...event }));
}
