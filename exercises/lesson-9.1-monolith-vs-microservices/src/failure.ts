import { z } from 'zod';
import { monolith, microservices, stop, stopAll, type Topology } from './cluster';
import { boardLoad, type LoadResult } from './load';
import { ms, pad } from './random';

// Lesson 9.1 §১.৩ — একটা অংশ ভাঙলে বাকিটার কী হয়?
//
// ক. ভারী প্রতিবেশী: কেউ "সব comment এর export" চালাচ্ছে — CPU এর কাজ, প্রতিটা EXPORT_MS ধরে event loop
//    আটকায়, পরপর। একই সময়ে board খোলা হচ্ছে। Monolith এ export আর board একই process এ; microservices এ
//    export comments service এ — board tasks service এ, কিন্তু board এর comments এর সংখ্যা লাগে।
// খ. Crash: export এর একটা bug process মেরে ফেলল (OOM এর মতো)। Monolith এ সেই process টাই সব;
//    microservices এ শুধু comments service।
// গ. হিসাব: request এর পথে যত service, availability তত গুণ হয়।

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

// board/s = সফল board (পুরো বা comments ছাড়া) প্রতি সেকেন্ডে — দ্রুত error গোনা হয় না
function line(name: string, r: LoadResult): void {
	const served = r.requests === 0 ? 0 : (r.perSecond * (r.ok + r.degraded)) / r.requests;
	console.log(
		`   ${name.padEnd(44)} ${pad(served.toFixed(0), 7)} ${pad(ms(r.p50), 10)} ${pad(ms(r.p99), 10)} ${pad(pct(r.ok, r.requests), 8)} ${pad(pct(r.degraded, r.requests), 12)} ${pad(pct(r.errors, r.requests), 7)}`
	);
}

// export বারবার, একটার পর একটা, যতক্ষণ board এর load চলে
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
		`   ${'পথ'.padEnd(44)} সফল board/s     p50        p99    পুরো   comments ছাড়া   error`
	);

async function main(): Promise<void> {
	const exportEnv = { EXPORT_MS: String(cfg.EXPORT_MS) };
	const noTimeout = { CALLS: 'batched' };
	const withTimeout = { CALLS: 'batched', TIMEOUT_MS: String(cfg.TIMEOUT_MS) };

	console.log(
		`\n── ক. ভারী প্রতিবেশী: board খোলা (${cfg.CONCURRENCY} client) আর একই সময়ে export (প্রতিটা ~${cfg.EXPORT_MS} ms CPU, পরপর) ──`
	);
	header();
	{
		const t = await monolith(exportEnv);
		await boardLoad(t.entry.url, cfg.CONCURRENCY, 500);
		line(
			'monolith, export ছাড়া (তুলনার জন্য)',
			await boardLoad(t.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS)
		);
		line('monolith, export একই process এ', await withExport(t, t.entry.url));
		await stopAll(t);
	}
	{
		const t = await microservices(noTimeout, exportEnv);
		line('microservices, timeout ছাড়া', await withExport(t, t.comments.url));
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
		`\n── খ. Crash: export এর bug এ process মারা গেল — তারপর ${(cfg.DURATION_MS / 1000).toFixed(0)} s board খোলা ──`
	);
	header();
	{
		const t = await monolith(exportEnv);
		await boardLoad(t.entry.url, cfg.CONCURRENCY, 500);
		await stop(t.entry); // পুরো app — board ও এই process এ ছিল
		line(
			'monolith (একমাত্র process মারা গেল)',
			await boardLoad(t.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS)
		);
		await stopAll(t);
	}
	{
		const t = await microservices(noTimeout, exportEnv);
		await boardLoad(t.entry.url, cfg.CONCURRENCY, 500);
		await stop(t.comments);
		line(
			'microservices, comments মারা গেল, timeout ছাড়া',
			await boardLoad(t.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS)
		);
		await stopAll(t);
	}
	{
		const t = await microservices(withTimeout, exportEnv);
		await boardLoad(t.entry.url, cfg.CONCURRENCY, 500);
		await stop(t.comments);
		line(
			'microservices, comments মারা গেল, + fallback',
			await boardLoad(t.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS)
		);
		await stop(t.users); // এবার users — এর কোনো fallback নেই (assignee ছাড়া card দেখানোর নিয়ম বানানো হয়নি)
		line(
			'   … তারপর users ও মারা গেল (তার fallback নেই)',
			await boardLoad(t.entry.url, cfg.CONCURRENCY, cfg.DURATION_MS)
		);
		await stopAll(t);
	}

	console.log('\n── গ. হিসাব: board এর পথে k টা service, প্রতিটা আলাদাভাবে 99.9% available ──');
	console.log('   k   পুরো পথের availability   মাসে বন্ধ (৩০ দিন)');
	for (const k of [1, 3, 5, 10, 20]) {
		const a = 0.999 ** k;
		console.log(
			`  ${pad(k, 2)}   ${pad(`${(a * 100).toFixed(2)}%`, 22)}   ${pad(((1 - a) * 30 * 24 * 60).toFixed(0), 6)} মিনিট`
		);
	}
	console.log(
		'   (ধরে নেওয়া: ব্যর্থতা স্বাধীন আর প্রতিটা service এর নিজের 99.9%; fallback থাকলে সেই service পথ থেকে বাদ যায়)\n'
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
