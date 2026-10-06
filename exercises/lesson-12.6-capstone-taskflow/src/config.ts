import { z } from 'zod';

const schema = z.object({
	DATABASE_URL: z.string().url().default('postgres://taskflow:taskflow@localhost:5450/taskflow'),
	REDIS_URL: z.string().url().default('redis://localhost:6384')
});

export const config = schema.parse(process.env);
