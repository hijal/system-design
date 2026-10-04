import { env, heading, ms, mulberry32, n, pct, percentile, row } from './util';

const SEED = env('SEED', 11);
const GATEWAYS = env('GATEWAYS', 300);
const DELIVERIES = env('DELIVERIES', 4_444_444);
const ONLINE = env('ONLINE', 150_000_000);
const REDIS_NODES = env('REDIS_NODES', 10);
const CLIENTS = env('CLIENTS', 500_000);
const CAPACITY = env('CAPACITY', 20_000);
const TICK_MS = env('TICK_MS', 100);
const HORIZON_S = env('HORIZON_S', 600);
const BASE_MS = env('BASE_MS', 1_000);
const CAP_MS = env('CAP_MS', 60_000);
const FIRST_SPREAD_MS = env('FIRST_SPREAD_MS', 10_000);
const REJECT_COST = env('REJECT_COST', 0.2);

heading(
	`অংশ ক — কোন gateway কে message পাঠাব: peak এ ${n(DELIVERIES)} delivery/s, ${GATEWAYS}টা gateway`
);
console.log(
	row([
		['পথ', 50],
		['gateway প্রতি গৃহীত/s', 22],
		['কাজে লাগে', 11],
		['মাঝের স্তরে op/s', 18]
	])
);
const perGateway = DELIVERIES / GATEWAYS;
const routes: [string, number, number][] = [
	['সব gateway কে broadcast (একটা pub/sub channel)', DELIVERIES, DELIVERIES * GATEWAYS],
	[
		`user প্রতি channel, Redis Cluster এর পুরনো PUBLISH (${REDIS_NODES} node এ ছড়ায়)`,
		perGateway,
		DELIVERIES * REDIS_NODES
	],
	['user প্রতি channel, sharded pub/sub (SPUBLISH)', perGateway, DELIVERIES],
	['session registry (user → gateway) + সরাসরি পাঠানো', perGateway, DELIVERIES * 2]
];
for (const [name, received, middle] of routes) {
	console.log(
		row([
			[name, 50],
			[n(received), 22],
			[pct(perGateway, received, 1), 11],
			[n(middle), 18]
		])
	);
}
console.log(
	'"মাঝের স্তরে op/s" — broadcast এ প্রতিটা delivery প্রতিটা gateway পর্যন্ত; registry তে একটা lookup + একটা পাঠানো।'
);

type Policy = {
	name: string;
	delay: (attempt: number, random: () => number) => number;
	first: (random: () => number) => number;
	jitter: boolean;
};

const policies: Policy[] = [
	{ name: 'সাথে সাথে, ব্যর্থ হলে আবার সাথে সাথে', first: () => 0, delay: () => 0, jitter: false },
	{ name: 'সাথে সাথে, ব্যর্থ হলে ঠিক ১ s পরে', first: () => 0, delay: () => 1_000, jitter: false },
	{
		name: 'exponential backoff, jitter ছাড়া',
		first: () => 0,
		delay: (attempt) => Math.min(CAP_MS, BASE_MS * 2 ** attempt),
		jitter: false
	},
	{
		name: `প্রথমটা ০–${FIRST_SPREAD_MS / 1_000} s এ ছড়ানো + full jitter`,
		first: (random) => random() * FIRST_SPREAD_MS,
		delay: (attempt, random) => random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt),
		jitter: true
	}
];

interface Storm {
	peakAttempts: number;
	attempts: number;
	reconnected: number[];
}

function storm(policy: Policy): Storm {
	const random = mulberry32(SEED);
	const ticks = Math.ceil((HORIZON_S * 1_000) / TICK_MS);
	const buckets: Map<number, number>[] = Array.from({ length: ticks + 1 }, () => new Map());
	const schedule = (at: number, attempt: number, count: number): void => {
		const bucket = buckets[Math.min(ticks, Math.floor(at / TICK_MS))];
		if (bucket !== undefined) bucket.set(attempt, (bucket.get(attempt) ?? 0) + count);
	};
	for (let c = 0; c < CLIENTS; c++) schedule(policy.first(random), 0, 1);
	const reconnected: number[] = [];
	let peak = 0;
	let attempts = 0;
	const perTick = (CAPACITY * TICK_MS) / 1_000;
	for (let t = 0; t < ticks; t++) {
		const groups = [...(buckets[t] ?? new Map<number, number>()).entries()].sort(
			(a, b) => a[0] - b[0]
		);
		buckets[t] = new Map();
		const total = groups.reduce((sum, [, count]) => sum + count, 0);
		if (total === 0) continue;
		attempts += total;
		peak = Math.max(peak, (total * 1_000) / TICK_MS);
		const admitted = Math.max(
			0,
			Math.min(total, Math.floor((perTick - REJECT_COST * total) / (1 - REJECT_COST)))
		);
		const now = t * TICK_MS;
		const shares = groups.map(([, count]) => Math.floor((admitted * count) / total));
		let left = admitted - shares.reduce((sum, v) => sum + v, 0);
		groups.forEach(([, count], index) => {
			const extra = Math.min(left, count - (shares[index] ?? 0));
			shares[index] = (shares[index] ?? 0) + extra;
			left -= extra;
		});
		groups.forEach(([attempt, count], index) => {
			const share = shares[index] ?? 0;
			for (let k = 0; k < share; k++) reconnected.push(now + random() * TICK_MS);
			const rejected = count - share;
			if (rejected === 0) return;
			if (policy.jitter) {
				for (let k = 0; k < rejected; k++)
					schedule(now + Math.max(TICK_MS, policy.delay(attempt, random)), attempt + 1, 1);
			} else
				schedule(now + Math.max(TICK_MS, policy.delay(attempt, random)), attempt + 1, rejected);
		});
	}
	reconnected.sort((a, b) => a - b);
	return { peakAttempts: peak, attempts, reconnected };
}

heading(
	`অংশ খ — একটা gateway মরল: ${n(CLIENTS)} connection একসাথে reconnect, বাকি fleet এর handshake + auth + sync এর ক্ষমতা ${n(CAPACITY)}/s, প্রত্যাখ্যাত চেষ্টার খরচ ${REJECT_COST}`
);
console.log(
	row([
		['নীতি', 46],
		['চেষ্টা/s (শীর্ষ)', 16],
		['মোট চেষ্টা', 16],
		['প্রতি client', 12],
		['৫০% ফিরল', 10],
		['৯৯% ফিরল', 10],
		['সব ফিরল', 16]
	])
);
const show = (value: number): string =>
	Number.isFinite(value) ? ms(value) : `> ${HORIZON_S / 60} মি`;
const results = policies.map((policy) => ({ policy, result: storm(policy) }));
for (const { policy, result } of results) {
	const at = (p: number): string =>
		result.reconnected.length >= CLIENTS * (p / 100) ? ms(percentile(result.reconnected, p)) : '—';
	console.log(
		row([
			[policy.name, 46],
			[n(result.peakAttempts), 16],
			[n(result.attempts), 16],
			[n(result.attempts / CLIENTS), 12],
			[at(50), 10],
			[at(99), 10],
			[
				result.reconnected.length === CLIENTS
					? at(100)
					: `${pct(result.reconnected.length, CLIENTS, 0)} (${HORIZON_S / 60} মি এ)`,
				16
			]
		])
	);
}
console.log(
	`সবচেয়ে ভালো সম্ভব: ${n(CLIENTS)} ÷ ${n(CAPACITY)}/s = ${ms((CLIENTS / CAPACITY) * 1_000)}।`
);

heading('অংশ গ — reconnect এর জানালায় ওই user দের কাছে যাওয়া message');
const perUser = DELIVERIES / ONLINE;
console.log(
	`user প্রতি ${perUser.toFixed(4)} delivery/s → এই ${n(CLIENTS)} জনের কাছে ${n(perUser * CLIENTS)}/s। Registry তখনও মরা gateway দেখায়।\n`
);
console.log(
	row([
		['নীতি', 46],
		['শুধু push: হারাল', 18],
		['আগে store, তারপর push: হারাল', 30],
		['দেরি p50', 10],
		['দেরি p99', 10]
	])
);
for (const { policy, result } of results) {
	const random = mulberry32(SEED + 3);
	const count = Math.round(perUser * CLIENTS * 30);
	let lost = 0;
	const delays: number[] = [];
	for (let i = 0; i < count; i++) {
		const sentAt = random() * 30_000;
		const back =
			result.reconnected[Math.floor(random() * result.reconnected.length)] ??
			Number.POSITIVE_INFINITY;
		if (back > sentAt) {
			lost++;
			delays.push(back - sentAt);
		} else delays.push(0);
	}
	delays.sort((a, b) => a - b);
	console.log(
		row([
			[policy.name, 46],
			[`${n(lost)} (${pct(lost, count, 0)})`, 18],
			['0', 30],
			[show(percentile(delays, 50)), 10],
			[show(percentile(delays, 99)), 10]
		])
	);
}
console.log(
	'প্রথম ৩০ s এ পাঠানো message। "শুধু push" এ registry এর পুরনো gateway এ গিয়ে হারায়; "আগে store" এ inbox এ থাকে, reconnect এর পরে sync এ আসে — দেরি নিয়ে।'
);
