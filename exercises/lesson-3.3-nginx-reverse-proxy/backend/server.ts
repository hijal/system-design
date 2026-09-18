import express, { type Request, type Response } from 'express';

interface Task {
	id: number;
	title: string;
}

interface TaskListResponse {
	tasks: Task[];
	servedBy: string;
}

interface HealthResponse {
	status: 'ok';
	instance: string;
}

// Docker Compose থেকে environment variable দিয়ে প্রতিটা instance কে
// একটা নাম দেওয়া হবে, যাতে আমরা দেখতে পারি Nginx কোন instance এ
// request পাঠাচ্ছে (Round Robin verify করার জন্য এটাই key trick)
const INSTANCE_ID: string = process.env.INSTANCE_ID ?? 'unknown-instance';

const tasks: Task[] = [
	{ id: 1, title: 'Fix login bug' },
	{ id: 2, title: 'Write Q3 report' }
];

const app = express();

app.get('/api/tasks', (_req: Request, res: Response<TaskListResponse>): void => {
	res.status(200).json({ tasks, servedBy: INSTANCE_ID });
});

app.get('/health', (_req: Request, res: Response<HealthResponse>): void => {
	res.status(200).json({ status: 'ok', instance: INSTANCE_ID });
});

const PORT = 3000;
app.listen(PORT, (): void => {
	console.log(`Backend instance "${INSTANCE_ID}" listening on port ${PORT}`);
});
