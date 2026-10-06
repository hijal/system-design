import { z } from 'zod';

export const taskEventSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('task.created'),
		eventId: z.string().uuid(),
		taskId: z.number().int().positive(),
		boardId: z.number().int().positive()
	}),
	z.object({
		type: z.literal('task.moved'),
		eventId: z.string().uuid(),
		taskId: z.number().int().positive(),
		column: z.string(),
		position: z.number().int()
	}),
	z.object({
		type: z.literal('task.assigned'),
		eventId: z.string().uuid(),
		taskId: z.number().int().positive(),
		assigneeId: z.string(),
		title: z.string()
	})
]);

export type TaskEvent = z.infer<typeof taskEventSchema>;
