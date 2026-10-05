import { z } from 'zod';
import { type Proc, start, stop, totalCpuMicros } from './cluster';
import { httpGet } from './http';
import { ms, pad, percentile } from './random';
import { signInternal, signJwt } from './token';

// Lesson 9.2 §1.4–1.5 — API Gateway: one door for every outside request.
//
// a. The cost of the extra hop: the tasks service directly, vs through the gateway (token check + proxy)
// b. Identity: the gateway checks the token and sets the user id. But what if someone bypasses the gateway and reaches the service directly?
//    two modes: trust (the service trusts x-user-id) and signed (it verifies the gateway's signature)
// c. Canary / strangler fig: the thumbnail route — the old path (monolith) vs the new files service, split by user

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
			`\n── a. Extra hop: tasks service directly vs through the gateway (token check + proxy) ──`
		);
		console.log(
			`   ${'path'.padEnd(34)} 1 client p50  ${cfg.CONCURRENCY} clients: req/s        p50        p99   gateway CPU / request`
		);
		const rows: {
			name: string;
			url: (i: number) => string;
			headers: Record<string, string>;
			gw: Proc | null;
		}[] = [
			{
				name: 'client → tasks (direct)',
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
	console.log(
		"\n── b. Who sent it? — the gateway's check, and bypassing the gateway to the service directly ──"
	);
	console.log(`   ${'request'.padEnd(58)} ${'trust mode'.padEnd(32)} signed mode`);
	const results = new Map<string, string[]>();
	const cases: {
		name: string;
		via: 'gateway' | 'direct';
		headers: (mode: string) => Record<string, string> | null;
	}[] = [
		{ name: 'gateway, no token', via: 'gateway', headers: () => ({}) },
		{ name: 'gateway, valid token for user 42', via: 'gateway', headers: () => bearer(42) },
		{
			name: 'gateway, valid token + self-set x-user-id: 1',
			via: 'gateway',
			headers: () => ({ ...bearer(42), 'x-user-id': '1' })
		},
		{ name: 'gateway, expired token', via: 'gateway', headers: () => bearer(42, -60) },
		{
			name: 'gateway, token made with another secret (sub: 1)',
			via: 'gateway',
			headers: () => ({
				authorization: `Bearer ${signJwt({ sub: 1, exp: Date.now() / 1000 + 3600 }, 'guessed-secret')}`
			})
		},
		{
			name: 'service directly (bypassing gateway), x-user-id: 1',
			via: 'direct',
			headers: () => ({ 'x-user-id': '1' })
		},
		{
			name: 'service directly, real x-internal-auth 70 s old (user 42)',
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
		const trustCell = trust === '200 · user 1' ? `${trust} ← impersonated` : (trust ?? '');
		console.log(`   ${c.name.padEnd(58)} ${trustCell.padEnd(32)} ${signed ?? ''}`);
	}
}

async function canary(): Promise<void> {
	console.log(
		`\n── c. The thumbnail route: old path (monolith) vs new files service — ${cfg.USERS} users, 2 times each ──`
	);
	console.log('   canary %   to new service    old path     same side both times');
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
	console.log(
		"   (split by a hash of the user id — so a user's experience doesn't jump between requests)\n"
	);
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
