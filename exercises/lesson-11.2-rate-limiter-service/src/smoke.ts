import type { Server } from 'node:http';
import { createApi } from './api';
import { type ClientOptions, LimiterClient } from './client';
import { createLimiterService, type Rule } from './limiter-service';
import { heading, padEnd } from './util';

const rules: Rule[] = [
	{ prefix: 'api:big', rate: 1_000, burst: 200, failMode: 'local' },
	{ prefix: 'api:', rate: 10, burst: 10, failMode: 'local' },
	{ prefix: 'login:', rate: 5, burst: 5, failMode: 'closed' }
];

let clock = 1_000_000;
const limiter = createLimiterService(rules, () => clock);

const listen = (app: { listen: (port: number) => Server }, port = 0): Promise<Server> =>
	new Promise((resolve) => {
		const server = app.listen(port);
		server.once('listening', () => resolve(server));
	});
const portOf = (server: Server): number => {
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('could not get the port');
	return address.port;
};
const close = (server: Server): Promise<void> =>
	new Promise((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let step = 0;
const show = (what: string, result: string): void => {
	step++;
	console.log(padEnd(step, 4) + padEnd(what, 58) + result);
};

async function main(): Promise<void> {
	let limiterServer = await listen(limiter.app);
	const limiterPort = portOf(limiterServer);
	const base: ClientOptions = {
		baseUrl: `http://127.0.0.1:${limiterPort}`,
		rules,
		servers: 2,
		timeoutMs: 20,
		breakerFailures: 3,
		breakerOpenMs: 300
	};
	const clientA = new LimiterClient(base);
	const clientB = new LimiterClient(base);
	const clientLease = new LimiterClient({ ...base, leaseSize: 5 });
	const clientSlow = new LimiterClient(base);
	const servers = await Promise.all(
		[clientA, clientB, clientLease, clientSlow].map((c) => listen(createApi(c)))
	);
	const [a, b, leased, slow] = servers.map((s) => `http://127.0.0.1:${portOf(s)}`);
	if (a === undefined || b === undefined || leased === undefined || slow === undefined)
		throw new Error('the API did not start');

	const call = async (
		api: string,
		path: string,
		key: string
	): Promise<{ status: number; retryAfter: string; source: string }> => {
		const res = await fetch(`${api}${path}`, {
			method: path === '/login' ? 'POST' : 'GET',
			headers: { 'x-api-key': key }
		});
		await res.text();
		return {
			status: res.status,
			retryAfter: res.headers.get('retry-after') ?? '-',
			source: res.headers.get('x-ratelimit-source') ?? '-'
		};
	};
	const tally = (statuses: number[]): string => {
		const counts = new Map<number, number>();
		for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
		return [...counts.entries()]
			.sort((x, y) => x[0] - y[0])
			.map(([s, c]) => `${s} × ${c}`)
			.join(', ');
	};

	heading('one limiter service, two API servers (A, B), fake clock; limits: api 10/s, login 5/s');
	console.log(padEnd('#', 4) + padEnd('step', 58) + 'result');

	const fromA: number[] = [];
	const fromB: number[] = [];
	let last = { status: 0, retryAfter: '-', source: '-' };
	for (let i = 0; i < 15; i++) {
		fromA.push((await call(a, '/data', 'acme')).status);
		last = await call(b, '/data', 'acme');
		fromB.push(last.status);
	}
	show('key acme: 15 on A, 15 on B, alternating', `A: ${tally(fromA)} | B: ${tally(fromB)}`);
	show("the last 429's headers", `Retry-After: ${last.retryAfter}, source: ${last.source}`);

	clock += 1_000;
	const after: number[] = [];
	for (let i = 0; i < 12; i++)
		after.push((await call(i % 2 === 0 ? a : b, '/data', 'acme')).status);
	show('clock forward 1 s, 12 more', tally(after));

	const checksBefore = limiter.stats.checks;
	const plain: number[] = [];
	for (let i = 0; i < 100; i++) plain.push((await call(a, '/data', 'big-plain')).status);
	show(
		'key big-plain (1,000/s): 100 on A, check on every request',
		`${tally(plain)}; ${limiter.stats.checks - checksBefore} calls to the limiter`
	);

	const leasesBefore = limiter.stats.leases;
	const viaLease: number[] = [];
	for (let i = 0; i < 100; i++) viaLease.push((await call(leased, '/data', 'big-co')).status);
	show(
		'key big-co: 100 to the API with leases (5)',
		`${tally(viaLease)}; ${limiter.stats.leases - leasesBefore} lease calls to the limiter`
	);

	await fetch(`http://127.0.0.1:${limiterPort}/admin/delay`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ms: 200 })
	});
	let started = performance.now();
	const slowData = await call(slow, '/data', 'slowpoke');
	const slowDataMs = performance.now() - started;
	show(
		'limiter 200 ms slow, timeout 20 ms: GET /data (local)',
		`${slowData.status}, source: ${slowData.source}, ${slowDataMs < 100 ? 'under 100 ms' : 'slow!'}`
	);
	started = performance.now();
	const slowLogin = await call(slow, '/login', 'x');
	const slowLoginMs = performance.now() - started;
	show(
		'at the same time POST /login (fail closed)',
		`${slowLogin.status}, Retry-After: ${slowLogin.retryAfter}, ${slowLoginMs < 100 ? 'under 100 ms' : 'slow!'}`
	);

	await fetch(`http://127.0.0.1:${limiterPort}/admin/delay`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ms: 0 })
	});
	await close(limiterServer);
	const callsBefore = clientA.networkCalls;
	const outage: number[] = [];
	const sources: string[] = [];
	for (let i = 0; i < 8; i++) {
		const r = await call(a, '/data', 'outage');
		outage.push(r.status);
		sources.push(r.source);
	}
	show(
		'limiter down: 8 GET /data on A',
		`${tally(outage)}; source: ${[...new Set(sources)].join(', ')}`
	);
	show(
		'network calls toward the limiter during that',
		`${clientA.networkCalls - callsBefore} (the breaker opens after 3 failures)`
	);
	const login = await call(a, '/login', 'x');
	show('limiter down: POST /login', `${login.status}, Retry-After: ${login.retryAfter}`);

	limiterServer = await listen(limiter.app, limiterPort);
	await sleep(350);
	const backBefore = clientA.networkCalls;
	const back = await call(a, '/data', 'back');
	show(
		'limiter back, 300 ms after the breaker',
		`${back.status}, source: ${back.source}, ${clientA.networkCalls - backBefore} network call(s)`
	);

	await Promise.all([limiterServer, ...servers].map(close));
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
