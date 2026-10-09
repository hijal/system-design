import { z } from 'zod';
import { monolith, microservices, stop, stopAll, type Topology } from './cluster';
import { boardLoad, type LoadResult } from './load';
import { ms, pad } from './random';

// Lesson 9.1 §1.3 - when one part breaks, what happens to the rest?
//
// a. A heavy neighbour: someone is running "export every comment" - CPU work, each blocking the event loop for EXPORT_MS,
//    back to back. Boards are being opened at the same time. In the monolith the export and the board share a process; in microservices
//    the export is in the comments service - the board in the tasks service, but the board needs the comment counts.
// b. Crash: a bug in the export killed the process (like an OOM). In the monolith that process is everything;
//    in microservices only the comments service.
// c. Arithmetic: the more services on the request path, the more availabilities multiply.

const cfg = z
	.object({
		CONCURRENCY: z.coerce.number().int().positive().default(8),
		DURATION_MS: z.coerce.number().int().positive().default(5000),
		EXPORT_MS: z.coerce.number().int().positive().default(300),
		TIMEOUT_MS: z.coerce.number().int().positive().default(50)
	})
	.parse(process.env);

const pct = (n: number, total: number): string =>
	`${total === 0 ? '0' : ((n / total) * 100).toFixed(0)}%`;

// boards/s = successful boards (full or without comments) per second - fast errors aren't counted
function line(name: string, r: LoadResult): void {
	const served = r.requests === 0 ? 0 : (r.perSecond * (r.ok + r.degraded)) / r.requests;
	console.log(
		`   ${name.padEnd(44)} ${pad(served.toFixed(0), 11)} ${pad(ms(r.p50), 10)} ${pad(ms(r.p99), 10)} ${pad(pct(r.ok, r.requests), 8)} ${pad(pct(r.degraded, r.requests), 12)} ${pad(pct(r.errors, r.requests), 7)}`
	);
}

// the export again and again, one after another, as long as the board load runs
async function exportLoop(url: string, until: number): Promise<number> {
	let done = 0;
	while (performance.now() < until) {
		try {
			const res = await fetch(`${url}/export`);
			await res.json();
			done++;
		} catch {
			return done;
		}
	}
	return done;
}

async function withExport(topology: Topology, exportUrl: string): Promise<LoadResult> {
	await boardLoad(topology.entry.url, cfg.CONCURRENCY, 500); // warm-up
	const until = performance.now() + cfg.DURATION_MS;
	const [r] = await Promise.all([
		boardLoad(topology.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS),
		exportLoop(exportUrl, until)
	]);
	return r;
}

const header = (): void =>
	console.log(
		'   path                                         boards/s ok        p50        p99     full  no comments   error'
	);

async function main(): Promise<void> {
	const exportEnv = { EXPORT_MS: String(cfg.EXPORT_MS) };
	const noTimeout = { CALLS: 'batched' };
	const withTimeout = { CALLS: 'batched', TIMEOUT_MS: String(cfg.TIMEOUT_MS) };

	console.log(
		`\n── A. Heavy neighbour: opening the board (${cfg.CONCURRENCY} clients) while an export runs (~${cfg.EXPORT_MS} ms CPU each, back to back) ──`
	);
	header();
	{
		const t = await monolith(exportEnv);
		await boardLoad(t.entry.url, cfg.CONCURRENCY, 500);
		line(
			'monolith, no export (for comparison)',
			await boardLoad(t.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS)
		);
		line('monolith, export in the same process', await withExport(t, t.entry.url));
		await stopAll(t);
	}
	{
		const t = await microservices(noTimeout, exportEnv);
		line('microservices, no timeout', await withExport(t, t.comments.url));
		await stopAll(t);
	}
	{
		const t = await microservices(withTimeout, exportEnv);
		line(
			`microservices, timeout ${cfg.TIMEOUT_MS} ms + fallback`,
			await withExport(t, t.comments.url)
		);
		await stopAll(t);
	}

	console.log(
		`\n── B. Crash: a bug in the export killed the process - then ${(cfg.DURATION_MS / 1000).toFixed(0)} s of opening boards ──`
	);
	header();
	{
		const t = await monolith(exportEnv);
		await boardLoad(t.entry.url, cfg.CONCURRENCY, 500);
		await stop(t.entry); // the whole app - the board was in this process too
		line(
			'monolith (the only process died)',
			await boardLoad(t.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS)
		);
		await stopAll(t);
	}
	{
		const t = await microservices(noTimeout, exportEnv);
		await boardLoad(t.entry.url, cfg.CONCURRENCY, 500);
		await stop(t.comments);
		line(
			'microservices, comments died, no timeout',
			await boardLoad(t.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS)
		);
		await stopAll(t);
	}
	{
		const t = await microservices(withTimeout, exportEnv);
		await boardLoad(t.entry.url, cfg.CONCURRENCY, 500);
		await stop(t.comments);
		line(
			'microservices, comments died, + fallback',
			await boardLoad(t.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS)
		);
		await stop(t.users); // users this time - it has no fallback (no rule was made for showing a card without an assignee)
		line(
			'   … then users died (no fallback)',
			await boardLoad(t.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS)
		);
		await stopAll(t);
	}

	console.log(
		"\n── C. Arithmetic: k services on the board's path, each independently 99.9% available ──"
	);
	console.log('   k        path availability   downtime per 30 days');
	for (const k of [1, 3, 5, 10, 20]) {
		const a = 0.999 ** k;
		console.log(
			`  ${pad(k, 2)}   ${pad(`${(a * 100).toFixed(2)}%`, 22)}   ${pad(((1 - a) * 30 * 24 * 60).toFixed(0), 6)} minutes`
		);
	}
	console.log(
		'   (assumed: failures are independent and each service has its own 99.9%; with a fallback that service drops off the path)\n'
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
