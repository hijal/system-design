import { httpGet } from './http';

// A simple model of the link between the browser and the data center:
//   - one round trip (RTT) per request — half going, half coming back
//   - the response bytes come through one shared pipe (MBPS) — with several requests at once they queue up
// The servers' own work is real (real HTTP on localhost). TCP slow start, TLS, packet loss — not in this model.

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
		await sleep(this.profile.rttMs / 2); // for the request to arrive
		const { status, body } = await httpGet(url);
		if (status < 200 || status >= 300) throw new Error(`${url} → ${status}`);
		const size = Buffer.byteLength(body);
		this.bytes += size;
		// the response bytes in the pipe: after the previous response, if it has not finished
		const now = performance.now();
		const start = Math.max(now, this.#pipeFreeAt);
		this.#pipeFreeAt = start + (size * 8) / (this.profile.mbps * 1000); // mbps → bits per ms
		await sleep(this.#pipeFreeAt - now + this.profile.rttMs / 2); // for the last byte to arrive back
		return JSON.parse(body);
	}
}
