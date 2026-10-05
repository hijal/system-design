import { BloomFilter } from './bloom';
import { heading, mulberry32, pct, row, zipfSampler } from './random';

const LINKS = Number(process.env.LINKS ?? 200_000);
const REQUESTS = Number(process.env.REQUESTS ?? 1_000_000);
const RPS = Number(process.env.RPS ?? 5_000);
const BOT = Number(process.env.BOT ?? 0.2);
const CACHE = Number(process.env.CACHE ?? 50_000);
const NEGATIVE_TTL = Number(process.env.NEGATIVE_TTL ?? 30);
const RATE = Number(process.env.RATE ?? 0.01);
const ZIPF = Number(process.env.ZIPF ?? 0.9);
const NEW_PER_SECOND = Number(process.env.NEW_PER_SECOND ?? 20);
const REBUILD = Number(process.env.REBUILD ?? 60);
const RECENT = Number(process.env.RECENT ?? 2_000);

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function slugMaker(seed: number): () => string {
	const random = mulberry32(seed);
	return () => {
		let slug = 's/';
		for (let i = 0; i < 8; i++) slug += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? 'A';
		return slug;
	};
}

type Entry = { found: boolean; expiresAt: number };

class LruCache {
	private readonly entries = new Map<string, Entry>();
	private readonly shortLived: [string, Entry][] = [];
	private head = 0;
	evictions = 0;

	constructor(private readonly capacity: number) {}

	get(key: string, now: number): Entry | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		this.entries.delete(key);
		if (entry.expiresAt <= now) return undefined;
		this.entries.set(key, entry);
		return entry;
	}

	expireDue(now: number): void {
		while (this.head < this.shortLived.length) {
			const [key, entry] = this.shortLived[this.head] ?? ['', { found: true, expiresAt: 0 }];
			if (entry.expiresAt > now) return;
			if (this.entries.get(key) === entry) this.entries.delete(key);
			this.head++;
		}
	}

	set(key: string, entry: Entry): void {
		this.entries.delete(key);
		this.entries.set(key, entry);
		if (!entry.found) this.shortLived.push([key, entry]);
		if (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) {
				this.entries.delete(oldest.value);
				this.evictions++;
			}
		}
	}

	negatives(now: number): number {
		let count = 0;
		for (const entry of this.entries.values()) if (!entry.found && entry.expiresAt > now) count++;
		return count;
	}
}

type Strategy = 'plain' | 'negative' | 'bloom';

type Outcome = {
	dbQueries: number;
	dbForMissing: number;
	legitHits: number;
	legit: number;
	junkAtEnd: number;
	evictions: number;
};

function simulate(strategy: Strategy): Outcome {
	const existing = Array.from({ length: LINKS }, slugMaker(1));
	const database = new Set(existing);
	const nextBotSlug = slugMaker(2);
	const sample = zipfSampler(LINKS, ZIPF, 3);
	const coin = mulberry32(4);
	const cache = new LruCache(CACHE);
	const filter = BloomFilter.forCapacity(LINKS, RATE);
	for (const slug of existing) filter.add(slug);
	let dbQueries = 0;
	let dbForMissing = 0;
	let legitHits = 0;
	let legit = 0;
	for (let i = 0; i < REQUESTS; i++) {
		const now = i / RPS;
		cache.expireDue(now);
		const isBot = coin() < BOT;
		const slug = isBot ? nextBotSlug() : (existing[sample()] ?? '');
		if (!isBot) legit++;
		if (strategy === 'bloom' && !filter.has(slug)) continue;
		const cached = cache.get(slug, now);
		if (cached) {
			if (!isBot) legitHits++;
			continue;
		}
		dbQueries++;
		const found = database.has(slug);
		if (!found) dbForMissing++;
		if (found) cache.set(slug, { found, expiresAt: now + 300 });
		else if (strategy === 'negative') cache.set(slug, { found, expiresAt: now + NEGATIVE_TTL });
	}
	return {
		dbQueries,
		dbForMissing,
		legitHits,
		legit,
		junkAtEnd: cache.negatives(REQUESTS / RPS),
		evictions: cache.evictions
	};
}

function enumeration(): void {
	const seconds = REQUESTS / RPS;
	heading(
		`A. ${LINKS.toLocaleString('en-US')} share links, ${pct(BOT, 1, 0)} of ${RPS.toLocaleString('en-US')} req/s are bots guessing random slugs — cache ${CACHE.toLocaleString('en-US')} entries`
	);
	console.log(
		row([
			['approach', 26],
			['DB query/s', 12],
			['of which "none"', 17],
			['real user hits', 17],
			['negative entries', 20],
			['evict', 10]
		])
	);
	const cases: [string, Strategy][] = [
		['cache only', 'plain'],
		[`+ negative cache ${NEGATIVE_TTL} s`, 'negative'],
		[`+ bloom filter ${RATE * 100}%`, 'bloom']
	];
	for (const [label, strategy] of cases) {
		const outcome = simulate(strategy);
		console.log(
			row([
				[label, 26],
				[Math.round(outcome.dbQueries / seconds).toLocaleString('en-US'), 12],
				[pct(outcome.dbForMissing, outcome.dbQueries, 1), 17],
				[pct(outcome.legitHits, outcome.legit, 1), 17],
				[outcome.junkAtEnd.toLocaleString('en-US'), 20],
				[outcome.evictions.toLocaleString('en-US'), 10]
			])
		);
	}
	const filter = BloomFilter.forCapacity(LINKS, RATE);
	console.log(
		`   filter: ${Math.round(filter.size / 8 / 1024).toLocaleString('en-US')} KB, k = ${filter.hashes} — built once, in every app instance's memory`
	);
}

type Upkeep = 'never' | 'rebuild' | 'on-create';

function freshness(upkeep: Upkeep): { wrong404: number; newRequests: number } {
	const makeSlug = slugMaker(1);
	const existing = Array.from({ length: LINKS }, makeSlug);
	const database = new Set(existing);
	const recent: string[] = [];
	const sample = zipfSampler(LINKS, ZIPF, 3);
	const coin = mulberry32(5);
	const build = (): BloomFilter => {
		const filter = BloomFilter.forCapacity(Math.round(LINKS * 1.2), RATE);
		for (const slug of database) filter.add(slug);
		return filter;
	};
	let filter = build();
	let lastBuild = 0;
	let wrong404 = 0;
	let newRequests = 0;
	const createEvery = Math.max(1, Math.round(RPS / NEW_PER_SECOND));
	for (let i = 0; i < REQUESTS; i++) {
		const now = i / RPS;
		if (i % createEvery === 0) {
			const slug = makeSlug();
			database.add(slug);
			recent.push(slug);
			if (recent.length > RECENT) recent.shift();
			if (upkeep === 'on-create') filter.add(slug);
		}
		if (upkeep === 'rebuild' && now - lastBuild >= REBUILD) {
			filter = build();
			lastBuild = now;
		}
		const fresh = recent.length > 0 && coin() < 0.05;
		const slug = fresh
			? (recent[Math.floor(coin() * recent.length)] ?? '')
			: (existing[sample()] ?? '');
		if (fresh) newRequests++;
		if (!filter.has(slug) && database.has(slug)) wrong404++;
	}
	return { wrong404, newRequests };
}

function staleFilter(): void {
	heading(
		`B. ${NEW_PER_SECOND} new links are created every second, and 5% of requests go to the latest ${RECENT.toLocaleString('en-US')} — does the filter know?`
	);
	console.log(
		row([
			['filter upkeep', 30],
			['404 on a real link', 23],
			['of new-link requests', 24]
		])
	);
	const cases: [string, Upkeep][] = [
		['built once at startup', 'never'],
		[`rebuilt from the DB every ${REBUILD} s`, 'rebuild'],
		['add to the filter on create', 'on-create']
	];
	for (const [label, upkeep] of cases) {
		const { wrong404, newRequests } = freshness(upkeep);
		console.log(
			row([
				[label, 30],
				[wrong404.toLocaleString('en-US'), 23],
				[pct(wrong404, newRequests, 1), 24]
			])
		);
	}
	console.log(
		'   (404 here is a false negative — the filter said "none" while it is in the DB. Bloom itself never does this)'
	);
}

enumeration();
staleFilter();
