import { z } from 'zod';
import { PROJECTS } from './domain';
import { percentile } from './random';

// The board's load: CONCURRENCY clients, each opening boards one after another, for DURATION_MS.
// Every client goes through the projects in a fixed order - the same every time.

const boardSchema = z.object({
	projectId: z.number(),
	cards: z.array(z.object({ id: z.number(), comments: z.number().nullable() })),
	degraded: z.boolean()
});

export type LoadResult = {
	requests: number;
	ok: number;
	degraded: number;
	errors: number;
	perSecond: number;
	p50: number;
	p99: number;
	max: number;
};

export async function boardLoad(
	baseUrl: string,
	concurrency: number,
	durationMs: number
): Promise<LoadResult> {
	const latencies: number[] = [];
	let ok = 0;
	let degraded = 0;
	let errors = 0;
	const deadline = performance.now() + durationMs;
	const client = async (c: number): Promise<void> => {
		for (let i = 0; performance.now() < deadline; i++) {
			const project = ((c * 7 + i) % PROJECTS) + 1;
			const t = performance.now();
			try {
				const res = await fetch(`${baseUrl}/board/${project}`);
				const body: unknown = await res.json();
				if (!res.ok) throw new Error(String(res.status));
				const board = boardSchema.parse(body);
				if (board.degraded) degraded++;
				else ok++;
			} catch {
				errors++;
			}
			latencies.push(performance.now() - t);
		}
	};
	const began = performance.now();
	await Promise.all(Array.from({ length: concurrency }, (_, c) => client(c)));
	const elapsed = performance.now() - began;
	return {
		requests: latencies.length,
		ok,
		degraded,
		errors,
		perSecond: (latencies.length / elapsed) * 1000,
		p50: percentile(latencies, 50),
		p99: percentile(latencies, 99),
		max: percentile(latencies, 100)
	};
}

// open one board and check that both paths return exactly the same answer
export async function fetchBoard(baseUrl: string, projectId: number): Promise<unknown> {
	const res = await fetch(`${baseUrl}/board/${projectId}`);
	return res.json();
}
