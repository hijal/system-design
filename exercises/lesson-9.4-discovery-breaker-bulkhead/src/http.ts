import http from 'node:http';

const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });

export type CallOutcome = 'ok' | 'timeout' | 'refused' | 'status';

export type CallResult = {
	outcome: CallOutcome;
	status: number;
	body: string;
	ms: number;
};

export function callService(url: string, timeoutMs: number): Promise<CallResult> {
	const started = performance.now();
	return new Promise((resolve) => {
		let settled = false;
		const finish = (outcome: CallOutcome, status: number, body: string): void => {
			if (settled) return;
			settled = true;
			resolve({ outcome, status, body, ms: performance.now() - started });
		};
		const req = http.get(url, { agent }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => {
				const status = res.statusCode ?? 0;
				const body = Buffer.concat(chunks).toString();
				if (status >= 200 && status < 300) finish('ok', status, body);
				else finish('status', status, body);
			});
			res.on('error', () => finish('refused', 0, ''));
		});
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			finish('timeout', 0, '');
		});
		req.on('error', () => finish('refused', 0, ''));
	});
}

export function closeAgent(): void {
	agent.destroy();
}
