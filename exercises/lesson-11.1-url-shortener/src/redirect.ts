import { bytes, env, heading, mulberry32, n, pct, row, share } from './util';

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
	`অংশ ক — redirect এর cache: ${n(LINKS)}টা link, ${n(REQUESTS)}টা redirect, জনপ্রিয়তা Zipf (s = ${ZIPF_S}), LRU`
);
console.log(
	row([
		['cache', 40],
		['entry', 12],
		['hit rate', 11],
		[`DB পড়া/s (peak ${n(PEAK_RPS)})`, 26],
		[`memory, ${n(ACTIVE_LINKS / 1e7)} কোটি link এ`, 24]
	])
);
const warmup = Math.floor(REQUESTS / 5);
const layouts: { name: string; fraction: number; servers: number }[] = [
	{ name: 'শেয়ার করা cache (Redis), link এর 0.1%', fraction: 0.001, servers: 1 },
	{ name: 'শেয়ার করা cache (Redis), link এর 1%', fraction: 0.01, servers: 1 },
	{ name: 'শেয়ার করা cache (Redis), link এর 5%', fraction: 0.05, servers: 1 },
	{ name: 'শেয়ার করা cache (Redis), link এর 20%', fraction: 0.2, servers: 1 },
	{
		name: `প্রতি app server এ local 0.1% (${APP_SERVERS}টা)`,
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
	`\nসবচেয়ে জনপ্রিয় link: সব redirect এর ${share(top, 1)} → peak এ ${n(top * PEAK_RPS)}/s, সব একটা cache node এ (key একটাই)।`
);
console.log(
	`Viral link ${n(VIRAL_RPS)}/s: শেয়ার করা cache এ এক node এ ${n(VIRAL_RPS)}/s; local cache এ প্রতি app server এ ${n(VIRAL_RPS / APP_SERVERS)}/s, cache node এ ~০।`
);

heading(
	`অংশ খ — 301 বনাম 302: ${n(USERS)} জন একটা link এ click করে, গড়ে আরও ${REPEAT_MEAN} বার ফেরে (মাঝে গড়ে ${GAP_HOURS} ঘণ্টা), ${share(HONOR_CACHE, 0)} browser cache রাখে; দিন ${TAKEDOWN_DAY} এ link বন্ধ`
);
console.log(
	row([
		['নীতি', 34],
		['click', 12],
		['server দেখল', 13],
		['analytics এ নেই', 17],
		['বন্ধের পরে click', 17],
		['তবুও গন্তব্যে গেল', 18]
	])
);
type Policy = { name: string; cacheHours: number };
const policies: Policy[] = [
	{ name: '301 (স্থায়ী, browser মনে রাখে)', cacheHours: Number.POSITIVE_INFINITY },
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
	'"তবুও গন্তব্যে গেল" = link বন্ধ করার পরেও browser এর cache থেকে পুরনো গন্তব্যে চলে যাওয়া click।'
);

heading(
	`অংশ গ — প্রতি link এ unique visitor: মাসে ${n(MONTHLY_CLICKS / 1e7)} কোটি click, ${n(ACTIVE_LINKS / 1e7)} কোটি link এ Zipf, click এর ${share(UNIQUE_SHARE, 0)} unique`
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
			['পদ্ধতি', 52],
			['memory', 12]
		]) + '   মন্তব্য'
	);
	console.log(
		row([
			['প্রতি link এ exact set (visitor hash, ' + SET_BYTES + ' B)', 52],
			[bytes(exact), 12]
		]) + '   নির্ভুল; জনপ্রিয় link এ বড়'
	);
	console.log(
		row([
			['প্রতি click করা link এ dense HLL (12 KB)', 52],
			[bytes(dense), 12]
		]) + `   ${n(clicked / 1e7)} কোটি link এ click — বেশিরভাগ ছোট`
	);
	console.log(
		row([
			['ছোট হলে set, বড় হলে HLL (Redis এর sparse → dense)', 52],
			[bytes(hybrid), 12]
		]) + `   মাত্র ${n(bigLinks)}টা link এ ${n(threshold)} এর বেশি unique`
	);
	console.log(
		row([
			['click event জমিয়ে রাতে batch এ গোনা (7.6)', 52],
			['0 RAM', 12]
		]) + `   disk এ ~${bytes(MONTHLY_CLICKS * 100)}/মাস raw event; দেরি কয়েক ঘণ্টা`
	);
	console.log(
		`\nসবচেয়ে জনপ্রিয় link এ মাসে ~${n(MONTHLY_CLICKS / harmonic)} click; ${n(ACTIVE_LINKS / 1e7)} কোটির মধ্যে মাঝের link এ ~${(MONTHLY_CLICKS / (Math.pow(ACTIVE_LINKS / 2, ZIPF_S) * harmonic)).toFixed(1)}টা।`
	);
}
