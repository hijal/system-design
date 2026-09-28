import http from 'node:http';

// ছোট একটা GET client — node:http, keep-alive সহ।
// কেন fetch না: Node 26 এর built-in fetch (undici) এ এই machine এ একটা অদ্ভুততা পাওয়া গেছে — অল্প বিরতির
// (১০ ms) পরে পরের request প্রায়ই ~৫০০ ms দেরি করে, localhost এও। এই exercise এ browser এর round trip এর
// ফাঁক গুলো ঠিক এমন বিরতি, তাই সংখ্যা নষ্ট হতো। node:http এ একই request ~১ ms।

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
