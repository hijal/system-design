import http from 'node:http';

// A small GET client — node:http, with keep-alive.
// Why not fetch: Node 26's built-in fetch (undici) showed an oddity on this machine — after a short pause
// (10 ms) the next request is often ~500 ms late, even on localhost. In this exercise the gaps between the browser's round trips
// are exactly such pauses, so the numbers would be ruined. With node:http the same request takes ~1 ms.

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

export type HttpResponse = { status: number; body: string };

export function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const req = http.get(url, { agent, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () =>
				resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
			);
			res.on('error', reject);
		});
		req.on('error', reject);
	});
}

export async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
	const res = await httpGet(url, headers);
	if (res.status < 200 || res.status >= 300) throw new Error(`${url} → ${res.status}`);
	return JSON.parse(res.body);
}
