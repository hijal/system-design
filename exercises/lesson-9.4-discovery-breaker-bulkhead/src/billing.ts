import http from 'node:http';

export type BillingMode = 'healthy' | 'slow' | 'error';

export type BillingInstance = {
	id: string;
	url: string;
	port: number;
	setMode: (mode: BillingMode) => void;
	setLatency: (healthyMs: number, slowMs: number) => void;
	handled: () => number;
	stop: () => Promise<void>;
};

export function startBilling(
	id: string,
	port: number,
	options: { healthyMs?: number; slowMs?: number; mode?: BillingMode } = {}
): Promise<BillingInstance> {
	let mode: BillingMode = options.mode ?? 'healthy';
	let healthyMs = options.healthyMs ?? 3;
	let slowMs = options.slowMs ?? 2000;
	let handled = 0;

	const server = http.createServer((req, res) => {
		const path = (req.url ?? '/').split('?')[0];
		if (path === '/health') {
			const healthy = mode !== 'error';
			res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ id, healthy, mode }));
			return;
		}
		handled += 1;
		if (mode === 'error') {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ id, error: 'billing unavailable' }));
			return;
		}
		const delay = mode === 'slow' ? slowMs : healthyMs;
		setTimeout(() => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ id, reserved: true }));
		}, delay);
	});

	server.keepAliveTimeout = 60_000;

	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			resolve({
				id,
				port,
				url: `http://127.0.0.1:${port}`,
				setMode: (next) => {
					mode = next;
				},
				setLatency: (nextHealthy, nextSlow) => {
					healthyMs = nextHealthy;
					slowMs = nextSlow;
				},
				handled: () => handled,
				stop: () =>
					new Promise((done) => {
						server.closeAllConnections();
						server.close(() => done());
					})
			});
		});
	});
}
