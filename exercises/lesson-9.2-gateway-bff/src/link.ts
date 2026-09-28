import { httpGet } from './http';

// Browser আর data center এর মাঝের link এর একটা সরল model:
//   - প্রতিটা request এ একটা round trip (RTT) — অর্ধেক যেতে, অর্ধেক ফিরতে
//   - উত্তরের byte গুলো একটা ভাগ করা পাইপ দিয়ে আসে (MBPS) — একসাথে কয়েকটা request হলে তারা লাইনে দাঁড়ায়
// সার্ভারের নিজের কাজ আসল (localhost এ আসল HTTP)। TCP slow start, TLS, packet loss — এই model এ নেই।

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export type Profile = { name: string; rttMs: number; mbps: number };
export const DESKTOP: Profile = { name: 'desktop (RTT 20 ms, 50 Mbps)', rttMs: 20, mbps: 50 };
export const MOBILE: Profile = { name: 'mobile (RTT 100 ms, 5 Mbps)', rttMs: 100, mbps: 5 };

export class Link {
	#pipeFreeAt = 0;
	requests = 0;
	bytes = 0;
	constructor(private readonly profile: Profile) {}

	async get(url: string): Promise<unknown> {
		this.requests++;
		await sleep(this.profile.rttMs / 2); // request পৌঁছাতে
		const { status, body } = await httpGet(url);
		if (status < 200 || status >= 300) throw new Error(`${url} → ${status}`);
		const size = Buffer.byteLength(body);
		this.bytes += size;
		// উত্তরের byte গুলো পাইপে: আগের উত্তর শেষ না হলে তার পরে
		const now = performance.now();
		const start = Math.max(now, this.#pipeFreeAt);
		this.#pipeFreeAt = start + (size * 8) / (this.profile.mbps * 1000); // mbps → bits per ms
		await sleep(this.#pipeFreeAt - now + this.profile.rttMs / 2); // শেষ byte ফেরত পৌঁছাতে
		return JSON.parse(body);
	}
}
