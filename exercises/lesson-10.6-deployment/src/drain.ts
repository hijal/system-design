import http from 'node:http';
import { env, heading, lognormal, ms, mulberry32, n, pct, percentile, row, sleep } from './util';

const PORT_BASE = env('PORT_BASE', 7610);
const INSTANCES = env('INSTANCES', 4);
const RATE = env('RATE', 200);
const RESTART_MS = env('RESTART_MS', 800);
const WARMUP_MS = env('WARMUP_MS', 1_500);
const CHECK_MS = env('CHECK_MS', 500);
const FAILS = 2;
const DRAIN_MS = CHECK_MS * FAILS + 500;
const SLOW_MS = 300;

type StopMode = 'kill' | 'close' | 'graceful';

type Instance = { stop: (how: StopMode) => Promise<void> };

async function startInstance(port: number, honestReadiness: boolean): Promise<Instance> {
	const startedAt = Date.now();
	const random = mulberry32(port * 7 + (startedAt % 997));
	const warm = (): boolean => Date.now() - startedAt >= WARMUP_MS;
	let draining = false;
	let inflight = 0;
	const server = http.createServer((req, res) => {
		if (req.url === '/ready') {
			const ok = !draining && (!honestReadiness || warm());
			res.writeHead(ok ? 200 : 503).end();
			return;
		}
		inflight++;
		req.resume();
		req.on('end', () => {
			const work = Math.min(800, lognormal(random, 40, 0.6)) + (warm() ? 0 : 400);
			setTimeout(() => {
				inflight--;
				if (!res.destroyed) res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
			}, work);
		});
	});
	server.keepAliveTimeout = 5_000;
	await new Promise<void>((resolve) => {
		server.listen(port, '127.0.0.1', resolve);
	});

	const closed = (): Promise<void> =>
		new Promise((resolve) => {
			const deadline = Date.now() + 10_000;
			const timer = setInterval(() => {
				server.closeIdleConnections();
				if (inflight === 0 || Date.now() > deadline) server.closeAllConnections();
			}, 20);
			server.close(() => {
				clearInterval(timer);
				resolve();
			});
		});

	return {
		stop: async (how) => {
			if (how === 'kill') {
				server.closeAllConnections();
				server.close();
				return;
			}
			if (how === 'graceful') {
				draining = true;
				await sleep(DRAIN_MS);
			}
			await closed();
		}
	};
}

type Backend = { port: number; healthy: boolean; fails: number; agent: http.Agent };
type Lb = { close: () => Promise<void> };

async function startLb(
	port: number,
	ports: number[],
	healthCheck: boolean,
	retryGet: boolean
): Promise<Lb> {
	const backends: Backend[] = ports.map((p) => ({
		port: p,
		healthy: true,
		fails: 0,
		agent: new http.Agent({ keepAlive: true, maxSockets: 64 })
	}));
	let next = 0;
	const pick = (exclude: Backend | null): Backend | undefined => {
		for (let k = 0; k < backends.length; k++) {
			const b = backends[next++ % backends.length];
			if (b && b !== exclude && (b.healthy || !healthCheck)) return b;
		}
		return undefined;
	};

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			const body = Buffer.concat(chunks);
			const forward = (attempt: number, exclude: Backend | null): void => {
				const b = pick(exclude);
				if (!b) {
					res.writeHead(503).end();
					return;
				}
				const upstream = http.request(
					{
						host: '127.0.0.1',
						port: b.port,
						method: req.method,
						path: req.url,
						agent: b.agent,
						headers: { 'content-length': body.length },
						timeout: 5_000
					},
					(answer) => {
						res.writeHead(answer.statusCode ?? 502);
						answer.pipe(res);
					}
				);
				upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
				upstream.on('error', () => {
					if (retryGet && req.method === 'GET' && attempt === 0) forward(1, b);
					else if (!res.headersSent) res.writeHead(502).end();
					else res.destroy();
				});
				upstream.end(body);
			};
			forward(0, null);
		});
	});

	const timer = healthCheck
		? setInterval(() => {
				for (const b of backends) {
					const probe = http.get(
						{ host: '127.0.0.1', port: b.port, path: '/ready', timeout: CHECK_MS * 0.8 },
						(answer) => {
							answer.resume();
							if (answer.statusCode === 200) {
								b.fails = 0;
								b.healthy = true;
							} else if (++b.fails >= FAILS) b.healthy = false;
						}
					);
					probe.on('timeout', () => probe.destroy());
					probe.on('error', () => {
						if (++b.fails >= FAILS) b.healthy = false;
					});
				}
			}, CHECK_MS)
		: null;

	await new Promise<void>((resolve) => {
		server.listen(port, '127.0.0.1', resolve);
	});
	return {
		close: () =>
			new Promise((resolve) => {
				if (timer) clearInterval(timer);
				for (const b of backends) b.agent.destroy();
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

type Sample = { method: 'GET' | 'POST'; ok: boolean; latency: number };

function load(port: number): { stop: () => Promise<Sample[]> } {
	const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
	const samples: Sample[] = [];
	const random = mulberry32(port);
	let pending = 0;
	const fire = (): void => {
		const method = random() < 0.8 ? 'GET' : 'POST';
		const started = performance.now();
		const body = method === 'POST' ? '{"title":"New task"}' : '';
		pending++;
		const done = (ok: boolean): void => {
			pending--;
			samples.push({ method, ok, latency: performance.now() - started });
		};
		const request = http.request(
			{
				host: '127.0.0.1',
				port,
				method,
				path: method === 'GET' ? '/boards/42' : '/tasks',
				agent,
				headers: { 'content-length': Buffer.byteLength(body) },
				timeout: 6_000
			},
			(answer) => {
				answer.resume();
				answer.on('end', () => done(answer.statusCode === 200));
				answer.on('error', () => done(false));
			}
		);
		request.on('timeout', () => request.destroy());
		request.on('error', () => done(false));
		request.end(body);
	};
	const perTick = RATE / 100;
	let carry = 0;
	const timer = setInterval(() => {
		carry += perTick;
		while (carry >= 1) {
			fire();
			carry--;
		}
	}, 10);
	return {
		stop: async () => {
			clearInterval(timer);
			const deadline = Date.now() + 7_000;
			while (pending > 0 && Date.now() < deadline) await sleep(20);
			agent.destroy();
			return samples;
		}
	};
}

type Mode = {
	name: string;
	healthCheck: boolean;
	retryGet: boolean;
	stop: StopMode;
	honestReadiness: boolean;
};

const MODES: Mode[] = [
	{
		name: 'no health check, abrupt kill',
		healthCheck: false,
		retryGet: false,
		stop: 'kill',
		honestReadiness: false
	},
	{
		name: 'health check, abrupt kill',
		healthCheck: true,
		retryGet: false,
		stop: 'kill',
		honestReadiness: false
	},
	{
		name: 'health check, abrupt kill, LB GET retry',
		healthCheck: true,
		retryGet: true,
		stop: 'kill',
		honestReadiness: false
	},
	{
		name: 'health check, only close() on SIGTERM',
		healthCheck: true,
		retryGet: false,
		stop: 'close',
		honestReadiness: false
	},
	{
		name: 'graceful: readiness → wait → close',
		healthCheck: true,
		retryGet: false,
		stop: 'graceful',
		honestReadiness: true
	}
];

async function runMode(mode: Mode): Promise<Sample[]> {
	const lbPort = PORT_BASE;
	const ports = Array.from({ length: INSTANCES }, (_, i) => PORT_BASE + 1 + i);
	const instances: Instance[] = [];
	for (const p of ports) instances.push(await startInstance(p, mode.honestReadiness));
	const lb = await startLb(lbPort, ports, mode.healthCheck, mode.retryGet);
	await sleep(WARMUP_MS + CHECK_MS * 2);
	const traffic = load(lbPort);
	await sleep(1_000);
	for (let i = 0; i < instances.length; i++) {
		const old = instances[i];
		const p = ports[i];
		if (!old || p === undefined) continue;
		await old.stop(mode.stop);
		await sleep(RESTART_MS);
		instances[i] = await startInstance(p, mode.honestReadiness);
		await sleep(WARMUP_MS + CHECK_MS * 2 + 200);
	}
	await sleep(1_000);
	const samples = await traffic.stop();
	await lb.close();
	for (const instance of instances) await instance.stop('kill');
	await sleep(300);
	return samples;
}

async function main(): Promise<void> {
	heading(
		`${INSTANCES} instances rolling restart, ${RATE} req/s (80% GET, 20% POST); restart ${ms(RESTART_MS)}, warm-up ${ms(WARMUP_MS)}, health check ${ms(CHECK_MS)} × ${FAILS}`
	);
	console.log(
		row([
			['design', 42],
			['request', 10],
			['GET fails', 12],
			['POST fails', 12],
			['total failed', 16],
			[`> ${SLOW_MS} ms`, 10],
			['p99', 10]
		])
	);
	for (const mode of MODES) {
		const samples = await runMode(mode);
		const gets = samples.filter((s) => s.method === 'GET');
		const posts = samples.filter((s) => s.method === 'POST');
		const failed = samples.filter((s) => !s.ok).length;
		const okLatency = samples
			.filter((s) => s.ok)
			.map((s) => s.latency)
			.sort((a, b) => a - b);
		console.log(
			row([
				[mode.name, 42],
				[n(samples.length), 10],
				[n(gets.filter((s) => !s.ok).length), 12],
				[n(posts.filter((s) => !s.ok).length), 12],
				[`${n(failed)} (${pct(failed, samples.length, 2)})`, 16],
				[n(okLatency.filter((l) => l > SLOW_MS).length), 10],
				[ms(percentile(okLatency, 99)), 10]
			])
		);
	}
	console.log(
		`\n("> ${SLOW_MS} ms" = successful but slow — mostly requests that reached an instance that had not warmed up)`
	);
}

void main();
