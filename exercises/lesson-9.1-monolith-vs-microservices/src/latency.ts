import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { monolith, microservices, stopAll, totalCpuMicros, type Topology } from './cluster';
import { TASKS_PER_PROJECT } from './domain';
import { boardLoad, fetchBoard } from './load';
import { ms, pad } from './random';

// Lesson 9.1 §১.২ — function call বনাম network call।
//
// একই board (একটা project এর ৫০টা task, প্রতিটার assignee আর comment এর সংখ্যা) তিনভাবে:
//   monolith            — tasks, users, comments এক process এ; board = কয়েকটা function call
//   microservices, chatty  — tasks service প্রতিটা task এর জন্য users আর comments কে আলাদা HTTP call
//   microservices, batched — দুটো HTTP call: সব user একবারে, সব গোনা একবারে (একসাথে)
// Client সবসময় একটা HTTP request পাঠায় (board) — পার্থক্য শুধু ভেতরে।
// সব process একই machine এ (localhost) — আসল network এর চেয়ে দ্রুত; NET_MS দিয়ে দেরি যোগ করা যায়।

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
			name: 'microservices, chatty (task প্রতি call)',
			calls: TASKS_PER_PROJECT * 2,
			topology: () => microservices({ CALLS: 'chatty' }, extra)
		},
		{
			name: 'microservices, batched (২টা call)',
			calls: 2,
			topology: () => microservices({ CALLS: 'batched' }, extra)
		}
	];

	console.log(
		`\n── Board খোলা${cfg.NET_MS > 0 ? ` — প্রতিটা internal call এ বাড়তি ${cfg.NET_MS} ms` : ' — সব process একই machine এ'} ──`
	);
	console.log(
		`   ${''.padEnd(40)}             একা ১ জন   ব্যস্ত: ${cfg.CONCURRENCY} জন একসাথে, ${(cfg.DURATION_MS / 1000).toFixed(0)} s`
	);
	console.log(
		`   ${'পথ'.padEnd(40)} ভেতরের call        p50    board/s        p99   CPU / board (সব process)`
	);

	let reference: unknown = null;
	for (const row of rows) {
		const topology = await row.topology();
		try {
			// একই উত্তর আসছে কিনা — না এলে তুলনার মানে নেই
			const board = await fetchBoard(topology.entry.url, 1);
			if (reference === null) reference = board;
			else if (!isDeepStrictEqual(board, reference)) throw new Error(`${row.name}: board আলাদা`);

			await boardLoad(topology.entry.url, 1, 500); // warm-up: JIT
			const alone = await boardLoad(topology.entry.url, 1, 2000); // একজন user, ফাঁকা system — শুধু পথের দৈর্ঘ্য
			await boardLoad(topology.entry.url, cfg.CONCURRENCY, 1000); // warm-up: বাকি keep-alive connection গুলো
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
		'\n   (তিনটা পথেই board হুবহু একই — যাচাই করা। Microservices এ ৩টা process, monolith এ ১টা — CPU এর কলাম সব process এর যোগফল।\n' +
			'    Monolith এর board/s এর সীমা load generator নিজে, monolith না — তুলনার জন্য CPU / board এর কলাম দেখো।)\n'
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
