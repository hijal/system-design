import { z } from 'zod';
import { type Proc, start, stop, totalCpuMicros } from './cluster';
import { httpGet } from './http';
import { ms, pad, percentile } from './random';
import { signInternal, signJwt } from './token';

// Lesson 9.2 §১.৪–১.৫ — API Gateway: সব বাইরের request এর একটা দরজা।
//
// ক. বাড়তি hop এর দাম: tasks service সরাসরি, বনাম gateway এর ভেতর দিয়ে (token যাচাই + proxy)
// খ. পরিচয়: gateway token যাচাই করে user id বসায়। কিন্তু কেউ gateway এড়িয়ে service এ সরাসরি পৌঁছালে?
//    দুই mode: trust (service x-user-id বিশ্বাস করে) আর signed (gateway এর sign যাচাই করে)
// গ. Canary / strangler fig: thumbnail এর route — পুরনো পথ (monolith) বনাম নতুন files service, user ধরে ভাগ

const cfg = z
	.object({
		CONCURRENCY: z.coerce.number().int().positive().default(16),
		DURATION_MS: z.coerce.number().int().positive().default(5000),
		USERS: z.coerce.number().int().positive().default(1000)
	})
	.parse(process.env);

const bearer = (sub: number, expInSec = 3600): Record<string, string> => ({
	authorization: `Bearer ${signJwt({ sub, exp: Date.now() / 1000 + expInSec })}`
});

type Load = { perSecond: number; p50: number; p99: number; requests: number; errors: number };

async function load(
	url: (i: number) => string,
	headers: Record<string, string>,
	concurrency: number,
	durationMs: number
): Promise<Load> {
	const latencies: number[] = [];
	let errors = 0;
	const deadline = performance.now() + durationMs;
	const client = async (c: number): Promise<void> => {
		for (let i = c; performance.now() < deadline; i += concurrency) {
			const t = performance.now();
			const res = await httpGet(url(i), headers);
			if (res.status !== 200) errors++;
			latencies.push(performance.now() - t);
		}
	};
	const began = performance.now();
	await Promise.all(Array.from({ length: concurrency }, (_, c) => client(c)));
	return {
		perSecond: (latencies.length / (performance.now() - began)) * 1000,
		p50: percentile(latencies, 50),
		p99: percentile(latencies, 99),
		requests: latencies.length,
		errors
	};
}

async function hopCost(): Promise<void> {
	const tasks = await start('tasks', { ROLE: 'tasks', AUTH_MODE: 'trust' });
	const gateway = await start('gateway', {
		ROLE: 'gateway',
		AUTH_MODE: 'trust',
		TASKS_URL: tasks.url
	});
	try {
		console.log(
			`\n── ক. বাড়তি hop: tasks service সরাসরি বনাম gateway এর ভেতর দিয়ে (token যাচাই + proxy) ──`
		);
		console.log(
			`   ${'পথ'.padEnd(34)} একা ১ জন p50   ব্যস্ত (${cfg.CONCURRENCY} জন): req/s        p50        p99   gateway এর CPU / request`
		);
		const rows: {
			name: string;
			url: (i: number) => string;
			headers: Record<string, string>;
			gw: Proc | null;
		}[] = [
			{
				name: 'client → tasks (সরাসরি)',
				url: (i) => `${tasks.url}/tasks/${(i % 2000) + 1}?requireViewer=1`,
				headers: { 'x-user-id': '42' },
				gw: null
			},
			{
				name: 'client → gateway → tasks',
				url: (i) => `${gateway.url}/api/tasks/${(i % 2000) + 1}`,
				headers: bearer(42),
				gw: gateway
			}
		];
		for (const row of rows) {
			await load(row.url, row.headers, 1, 500); // warm-up
			const alone = await load(row.url, row.headers, 1, 2000);
			await load(row.url, row.headers, cfg.CONCURRENCY, 1000);
			const before = row.gw ? await totalCpuMicros([row.gw]) : 0;
			const busy = await load(row.url, row.headers, cfg.CONCURRENCY, cfg.DURATION_MS);
			const after = row.gw ? await totalCpuMicros([row.gw]) : 0;
			const cpu = row.gw ? ms((after - before) / 1000 / busy.requests) : '—';
			console.log(
				`   ${row.name.padEnd(34)} ${pad(ms(alone.p50), 12)} ${pad(busy.perSecond.toFixed(0), 18)} ${pad(ms(busy.p50), 10)} ${pad(ms(busy.p99), 10)}   ${cpu}` +
					(alone.errors + busy.errors > 0 ? `   (error ${alone.errors + busy.errors})` : '')
			);
		}
	} finally {
		await Promise.all([stop(gateway), stop(tasks)]);
	}
}

async function identity(): Promise<void> {
	console.log('\n── খ. কে পাঠাল? — gateway এর যাচাই, আর gateway এড়িয়ে সরাসরি service এ ──');
	console.log(`   ${'request'.padEnd(58)} ${'trust mode'.padEnd(32)} signed mode`);
	const results = new Map<string, string[]>();
	const cases: {
		name: string;
		via: 'gateway' | 'direct';
		headers: (mode: string) => Record<string, string> | null;
	}[] = [
		{ name: 'gateway, token ছাড়া', via: 'gateway', headers: () => ({}) },
		{ name: 'gateway, user 42 এর বৈধ token', via: 'gateway', headers: () => bearer(42) },
		{
			name: 'gateway, বৈধ token + নিজে বসানো x-user-id: 1',
			via: 'gateway',
			headers: () => ({ ...bearer(42), 'x-user-id': '1' })
		},
		{ name: 'gateway, মেয়াদ পেরোনো token', via: 'gateway', headers: () => bearer(42, -60) },
		{
			name: 'gateway, অন্য secret এ বানানো token (sub: 1)',
			via: 'gateway',
			headers: () => ({
				authorization: `Bearer ${signJwt({ sub: 1, exp: Date.now() / 1000 + 3600 }, 'guessed-secret')}`
			})
		},
		{
			name: 'service সরাসরি (gateway এড়িয়ে), x-user-id: 1',
			via: 'direct',
			headers: () => ({ 'x-user-id': '1' })
		},
		{
			name: 'service সরাসরি, ৭০ s আগের আসল x-internal-auth (user 42)',
			via: 'direct',
			headers: (mode) =>
				mode === 'signed' ? { 'x-internal-auth': signInternal(42, Date.now() - 70_000) } : null
		}
	];
	for (const mode of ['trust', 'signed'] as const) {
		const tasks = await start('tasks', { ROLE: 'tasks', AUTH_MODE: mode });
		const gateway = await start('gateway', {
			ROLE: 'gateway',
			AUTH_MODE: mode,
			TASKS_URL: tasks.url
		});
		try {
			for (const c of cases) {
				const headers = c.headers(mode);
				let out = '—';
				if (headers) {
					const url =
						c.via === 'gateway'
							? `${gateway.url}/api/tasks/7`
							: `${tasks.url}/tasks/7?requireViewer=1`;
					const res = await httpGet(url, headers);
					const viewer = z
						.object({ viewer: z.number().nullable() })
						.safeParse(JSON.parse(res.body));
					out =
						res.status === 200 && viewer.success
							? `200 · user ${viewer.data.viewer}`
							: String(res.status);
				}
				results.set(c.name, [...(results.get(c.name) ?? []), out]);
			}
		} finally {
			await Promise.all([stop(gateway), stop(tasks)]);
		}
	}
	for (const c of cases) {
		const [trust, signed] = results.get(c.name) ?? [];
		const trustCell = trust === '200 · user 1' ? `${trust} ← অন্যের পরিচয়ে` : (trust ?? '');
		console.log(`   ${c.name.padEnd(58)} ${trustCell.padEnd(32)} ${signed ?? ''}`);
	}
}

async function canary(): Promise<void> {
	console.log(
		`\n── গ. Thumbnail এর route: পুরনো পথ (monolith) বনাম নতুন files service — ${cfg.USERS} জন user, প্রত্যেকে ২ বার ──`
	);
	console.log('   canary %   নতুন service এ   পুরনো পথে   একই user দুবার একই দিকে');
	const oldFiles = await start('files-old', { ROLE: 'files-old' });
	const newFiles = await start('files-new', { ROLE: 'files-new' });
	try {
		for (const percent of [0, 10, 50, 100]) {
			const gateway = await start('gateway', {
				ROLE: 'gateway',
				FILES_OLD_URL: oldFiles.url,
				FILES_NEW_URL: newFiles.url,
				CANARY_PERCENT: String(percent)
			});
			let toNew = 0;
			let sticky = 0;
			for (let u = 1; u <= cfg.USERS; u++) {
				const seen: string[] = [];
				for (let k = 0; k < 2; k++) {
					const res = await httpGet(`${gateway.url}/api/files/${u * 10 + k}/thumbnail`, bearer(u));
					seen.push(z.object({ servedBy: z.string() }).parse(JSON.parse(res.body)).servedBy);
				}
				if (seen[0] === 'files-new') toNew++;
				if (seen[0] === seen[1]) sticky++;
			}
			console.log(
				`   ${pad(`${percent}%`, 8)} ${pad(toNew, 16)} ${pad(cfg.USERS - toNew, 11)}   ${pad(`${((sticky / cfg.USERS) * 100).toFixed(0)}%`, 22)}`
			);
			await stop(gateway);
		}
	} finally {
		await Promise.all([stop(oldFiles), stop(newFiles)]);
	}
	console.log('   (ভাগ user id এর hash ধরে — তাই একজন user এর অভিজ্ঞতা request ভেদে লাফায় না)\n');
}

async function main(): Promise<void> {
	await hopCost();
	await identity();
	await canary();
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
