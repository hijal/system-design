import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { monolith, microservices, stopAll, totalCpuMicros, type Topology } from './cluster';
import { TASKS_PER_PROJECT } from './domain';
import { boardLoad, fetchBoard } from './load';
import { ms, pad } from './random';

// Lesson 9.1 §1.2 — a function call vs a network call.
//
// The same board (a project's 50 tasks, each with its assignee and comment count) three ways:
//   monolith            — tasks, users, comments in one process; the board = a few function calls
//   microservices, chatty  — the tasks service makes separate HTTP calls to users and comments for every task
//   microservices, batched — two HTTP calls: all users at once, all counts at once (in parallel)
// The client always sends one HTTP request (board) — the only difference is inside.
// All processes on the same machine (localhost) — faster than a real network; NET_MS adds delay.

const cfg = z
	.object({
		CONCURRENCY: z.coerce.number().int().positive().default(16),
		DURATION_MS: z.coerce.number().int().positive().default(5000),
		NET_MS: z.coerce.number().nonnegative().default(0)
	})
	.parse(process.env);

type Row = { name: string; calls: number; topology: () => Promise<Topology> };

async function main(): Promise<void> {
	const extra = { NET_MS: String(cfg.NET_MS) };
	const rows: Row[] = [
		{ name: 'monolith (function call)', calls: 0, topology: () => monolith() },
		{
			name: 'microservices, chatty (call per task)',
			calls: TASKS_PER_PROJECT * 2,
			topology: () => microservices({ CALLS: 'chatty' }, extra)
		},
		{
			name: 'microservices, batched (2 calls)',
			calls: 2,
			topology: () => microservices({ CALLS: 'batched' }, extra)
		}
	];

	console.log(
		`\n── Opening the board${cfg.NET_MS > 0 ? ` — ${cfg.NET_MS} ms extra on every internal call` : ' — all processes on one machine'} ──`
	);
	console.log(
		`${' '.repeat(52)}1 user alone  busy: ${cfg.CONCURRENCY} concurrent, ${(cfg.DURATION_MS / 1000).toFixed(0)} s`
	);
	console.log(
		'   path                                         calls        p50   boards/s        p99   CPU / board (all processes)'
	);

	let reference: unknown = null;
	for (const row of rows) {
		const topology = await row.topology();
		try {
			// whether the same answer comes back — otherwise the comparison means nothing
			const board = await fetchBoard(topology.entry.url, 1);
			if (reference === null) reference = board;
			else if (!isDeepStrictEqual(board, reference)) throw new Error(`${row.name}: board differs`);

			await boardLoad(topology.entry.url, 1, 500); // warm-up: JIT
			const alone = await boardLoad(topology.entry.url, 1, 2000); // one user, an empty system — just the length of the path
			await boardLoad(topology.entry.url, cfg.CONCURRENCY, 1000); // warm-up: the rest of the keep-alive connections
			const cpuBefore = await totalCpuMicros(topology.procs);
			const r = await boardLoad(topology.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS);
			const cpuAfter = await totalCpuMicros(topology.procs);
			const cpuPerBoard = (cpuAfter - cpuBefore) / 1000 / r.requests;
			console.log(
				`   ${row.name.padEnd(40)} ${pad(row.calls, 9)} ${pad(ms(alone.p50), 10)} ${pad(r.perSecond.toFixed(0), 10)} ${pad(ms(r.p99), 10)}   ${ms(cpuPerBoard)}` +
					(r.errors + alone.errors > 0 ? `   (error ${r.errors + alone.errors})` : '')
			);
		} finally {
			await stopAll(topology);
		}
	}
	console.log(
		'\n   (the board is exactly the same on all three paths — verified. Microservices run 3 processes, the monolith 1 — the CPU column is the sum over all processes.\n' +
			"    The monolith's boards/s is limited by the load generator itself, not the monolith — compare via the CPU / board column.)\n"
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
