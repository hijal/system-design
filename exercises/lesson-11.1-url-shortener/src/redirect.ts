import { big, bytes, env, heading, mulberry32, n, pct, row, share } from './util';

const SEED = env('SEED', 11);
const LINKS = env('LINKS', 2_000_000);
const REQUESTS = env('REQUESTS', 6_000_000);
const ZIPF_S = env('ZIPF_S', 1.0);
const PEAK_RPS = env('PEAK_RPS', 11_574);
const ENTRY_BYTES = env('ENTRY_BYTES', 250);
const ACTIVE_LINKS = env('ACTIVE_LINKS', 1_000_000_000);
const APP_SERVERS = env('APP_SERVERS', 10);
const VIRAL_RPS = env('VIRAL_RPS', 50_000);
const USERS = env('USERS', 100_000);
const REPEAT_MEAN = env('REPEAT_MEAN', 2);
const GAP_HOURS = env('GAP_HOURS', 24);
const HONOR_CACHE = env('HONOR_CACHE', 0.85);
const TAKEDOWN_DAY = env('TAKEDOWN_DAY', 7);
const MONTHLY_CLICKS = env('MONTHLY_CLICKS', 10_000_000_000);
const UNIQUE_SHARE = env('UNIQUE_SHARE', 0.6);
const SET_BYTES = env('SET_BYTES', 16);
const HLL_BYTES = 12 * 1024;

class Lru {
	private readonly prev: Int32Array;
	private readonly next: Int32Array;
	private readonly present: Uint8Array;
	private head = -1;
	private tail = -1;
	private size = 0;

	constructor(
		private readonly capacity: number,
		universe: number
	) {
		this.prev = new Int32Array(universe).fill(-1);
		this.next = new Int32Array(universe).fill(-1);
		this.present = new Uint8Array(universe);
	}

	private unlink(key: number): void {
		const p = this.prev[key] ?? -1;
		const q = this.next[key] ?? -1;
		if (p === -1) this.head = q;
		else this.next[p] = q;
		if (q === -1) this.tail = p;
		else this.prev[q] = p;
	}

	private pushFront(key: number): void {
		this.prev[key] = -1;
		this.next[key] = this.head;
		if (this.head !== -1) this.prev[this.head] = key;
		this.head = key;
		if (this.tail === -1) this.tail = key;
	}

	get(key: number): boolean {
		if (this.present[key] !== 1) return false;
		this.unlink(key);
		this.pushFront(key);
		return true;
	}

	put(key: number): void {
		this.present[key] = 1;
		this.pushFront(key);
		this.size++;
		if (this.size > this.capacity && this.tail !== -1) {
			const oldest = this.tail;
			this.unlink(oldest);
			this.present[oldest] = 0;
			this.size--;
		}
	}
}

const cdf = new Float64Array(LINKS);
{
	let sum = 0;
	for (let i = 0; i < LINKS; i++) {
		sum += 1 / Math.pow(i + 1, ZIPF_S);
		cdf[i] = sum;
	}
	for (let i = 0; i < LINKS; i++) cdf[i] = (cdf[i] ?? 0) / sum;
}
const sample = (u: number): number => {
	let lo = 0;
	let hi = LINKS - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((cdf[mid] ?? 1) < u) lo = mid + 1;
		else hi = mid;
	}
	return lo;
};

heading(
	`Part A — the redirect cache: ${n(LINKS)} links, ${n(REQUESTS)} redirects, Zipf popularity (s = ${ZIPF_S}), LRU`
);
console.log(
	row([
		['cache', 40],
		['entry', 12],
		['hit rate', 11],
		[`DB reads/s (peak ${n(PEAK_RPS)})`, 26],
		[`memory, at ${big(ACTIVE_LINKS)} links`, 24]
	])
);
const warmup = Math.floor(REQUESTS / 5);
const layouts: { name: string; fraction: number; servers: number }[] = [
	{ name: 'shared cache (Redis), 0.1% of links', fraction: 0.001, servers: 1 },
	{ name: 'shared cache (Redis), 1% of links', fraction: 0.01, servers: 1 },
	{ name: 'shared cache (Redis), 5% of links', fraction: 0.05, servers: 1 },
	{ name: 'shared cache (Redis), 20% of links', fraction: 0.2, servers: 1 },
	{
		name: `local 0.1% on each app server (${APP_SERVERS})`,
		fraction: 0.001,
		servers: APP_SERVERS
	}
];
for (const layout of layouts) {
	const random = mulberry32(SEED);
	const size = Math.max(1, Math.round(layout.fraction * LINKS));
	const caches = Array.from({ length: layout.servers }, () => new Lru(size, LINKS));
	let hits = 0;
	let counted = 0;
	for (let r = 0; r < REQUESTS; r++) {
		const link = sample(random());
		const cache = caches[Math.floor(random() * layout.servers)];
		if (cache === undefined) continue;
		const hit = cache.get(link);
		if (!hit) cache.put(link);
		if (r >= warmup) {
			counted++;
			if (hit) hits++;
		}
	}
	const hitRate = hits / counted;
	console.log(
		row([
			[layout.name, 40],
			[n(size), 12],
			[pct(hits, counted, 1), 11],
			[n(PEAK_RPS * (1 - hitRate)), 26],
			[
				bytes(layout.fraction * ACTIVE_LINKS * ENTRY_BYTES) +
					(layout.servers > 1 ? ` × ${layout.servers}` : ''),
				24
			]
		])
	);
}
const top = cdf[0] ?? 0;
console.log(
	`\nMost popular link: ${share(top, 1)} of all redirects → ${n(top * PEAK_RPS)}/s at peak, all on one cache node (it is one key).`
);
console.log(
	`Viral link at ${n(VIRAL_RPS)}/s: with a shared cache, ${n(VIRAL_RPS)}/s on one node; with a local cache, ${n(VIRAL_RPS / APP_SERVERS)}/s per app server and ~0 on the cache node.`
);

heading(
	`Part B — 301 vs 302: ${n(USERS)} people click a link, come back ${REPEAT_MEAN} more times on average (${GAP_HOURS} hours apart on average), ${share(HONOR_CACHE, 0)} of browsers keep the cache; the link is disabled on day ${TAKEDOWN_DAY}`
);
console.log(
	row([
		['policy', 34],
		['click', 12],
		['server saw', 13],
		['not in analytics', 18],
		['clicks after off', 17],
		['still reached dest', 18]
	])
);
type Policy = { name: string; cacheHours: number };
const policies: Policy[] = [
	{ name: '301 (permanent, browser remembers)', cacheHours: Number.POSITIVE_INFINITY },
	{ name: '302 + Cache-Control: max-age=3600', cacheHours: 1 },
	{ name: '302 + Cache-Control: private, no-store', cacheHours: 0 }
];
for (const policy of policies) {
	const random = mulberry32(SEED + 7);
	let clicks = 0;
	let seen = 0;
	let afterTakedown = 0;
	let leaked = 0;
	const takedown = TAKEDOWN_DAY * 24;
	for (let u = 0; u < USERS; u++) {
		const honors = random() < HONOR_CACHE;
		let t = random() * 14 * 24;
		let lastFetch = Number.NEGATIVE_INFINITY;
		let more = 0;
		while (random() < REPEAT_MEAN / (REPEAT_MEAN + 1)) more++;
		for (let c = 0; c <= more; c++) {
			clicks++;
			const cached = honors && t - lastFetch < policy.cacheHours;
			if (t >= takedown) afterTakedown++;
			if (cached) {
				if (t >= takedown) leaked++;
			} else {
				seen++;
				lastFetch = t;
			}
			t += -Math.log(1 - random()) * GAP_HOURS;
		}
	}
	console.log(
		row([
			[policy.name, 34],
			[n(clicks), 12],
			[pct(seen, clicks, 1), 13],
			[pct(clicks - seen, clicks, 1), 17],
			[n(afterTakedown), 17],
			[pct(leaked, afterTakedown, 1), 18]
		])
	);
}
console.log(
	'"still reached dest" = clicks that went to the old destination from the browser cache even after the link was disabled.'
);

heading(
	`Part C — unique visitors per link: ${big(MONTHLY_CLICKS)} clicks a month, Zipf over ${big(ACTIVE_LINKS)} links, ${share(UNIQUE_SHARE, 0)} of clicks unique`
);
{
	let harmonic = 0;
	const bins: [number, number][] = [];
	let start = 1;
	while (start <= ACTIVE_LINKS) {
		const end = Math.min(ACTIVE_LINKS, Math.max(start, Math.floor(start * 1.02)));
		bins.push([start, end]);
		for (let i = start; i <= Math.min(end, start + 2_000); i++) harmonic += 1 / Math.pow(i, ZIPF_S);
		if (end > start + 2_000)
			harmonic +=
				ZIPF_S === 1
					? Math.log((end + 0.5) / (start + 2_000.5))
					: (Math.pow(end + 0.5, 1 - ZIPF_S) - Math.pow(start + 2_000.5, 1 - ZIPF_S)) /
						(1 - ZIPF_S);
		start = end + 1;
	}
	let clicked = 0;
	let exact = 0;
	let dense = 0;
	let hybrid = 0;
	let bigLinks = 0;
	const threshold = HLL_BYTES / SET_BYTES;
	for (const [from, to] of bins) {
		const count = to - from + 1;
		const mid = (from + to) / 2;
		const clicks = MONTHLY_CLICKS / (Math.pow(mid, ZIPF_S) * harmonic);
		const uniques = Math.max(clicks * UNIQUE_SHARE, 0);
		const pClicked = 1 - Math.exp(-clicks);
		clicked += count * pClicked;
		exact += count * uniques * SET_BYTES;
		dense += count * pClicked * HLL_BYTES;
		hybrid += count * Math.min(uniques * SET_BYTES, HLL_BYTES * pClicked);
		if (uniques > threshold) bigLinks += count;
	}
	console.log(
		row([
			['method', 52],
			['memory', 12]
		]) + '   note'
	);
	console.log(
		row([
			['exact set per link (visitor hash, ' + SET_BYTES + ' B)', 52],
			[bytes(exact), 12]
		]) + '   exact; big on popular links'
	);
	console.log(
		row([
			['dense HLL (12 KB) per clicked link', 52],
			[bytes(dense), 12]
		]) + `   ${big(clicked)} links clicked — most of them small`
	);
	console.log(
		row([
			['set when small, HLL when big (Redis sparse → dense)', 52],
			[bytes(hybrid), 12]
		]) + `   only ${n(bigLinks)} links have more than ${n(threshold)} unique`
	);
	console.log(
		row([
			['collect click events, count in a nightly batch (7.6)', 52],
			['0 RAM', 12]
		]) + `   ~${bytes(MONTHLY_CLICKS * 100)}/month of raw events on disk; hours of delay`
	);
	console.log(
		`\nThe most popular link gets ~${n(MONTHLY_CLICKS / harmonic)} clicks a month; the median of the ${big(ACTIVE_LINKS)} links gets ~${(MONTHLY_CLICKS / (Math.pow(ACTIVE_LINKS / 2, ZIPF_S) * harmonic)).toFixed(1)}.`
	);
}
