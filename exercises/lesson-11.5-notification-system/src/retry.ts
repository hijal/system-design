import { env, heading, ms, mulberry32, n, pct, percentile, row } from './util';

const SEED = env('SEED', 11);
const MESSAGES = env('MESSAGES', 1_000_000);
const FAIL = env('FAIL', 0.01);
const TIMEOUT = env('TIMEOUT', 0.02);
const SENT_ON_TIMEOUT = env('SENT_ON_TIMEOUT', 0.5);
const RATE = env('RATE', 1_000);
const OUTAGE_S = env('OUTAGE_S', 600);
const BREAKER_S = env('BREAKER_S', 30);
const CAP_S = env('CAP_S', 300);

type Outcome = 'ok' | 'fail' | 'timeout';

type Policy = { name: string; retry: boolean; key: boolean; failover: boolean };

const policies: Policy[] = [
	{ name: 'একবার, retry নেই', retry: false, key: false, failover: false },
	{ name: 'ব্যর্থ বা timeout হলে আবার', retry: true, key: false, failover: false },
	{ name: 'আবার, provider এ idempotency key সহ', retry: true, key: true, failover: false },
	{
		name: 'timeout হলে দ্বিতীয় provider এ (key শেয়ার হয় না)',
		retry: true,
		key: true,
		failover: true
	}
];

heading(
	`অংশ ক — ${n(MESSAGES)}টা email: ${FAIL * 100}% স্পষ্ট ব্যর্থ (পাঠায়নি), ${TIMEOUT * 100}% timeout (তার ${SENT_ON_TIMEOUT * 100}% আসলে পাঠিয়েছিল)`
);
console.log(
	row([
		['নীতি', 52],
		['পৌঁছায়নি', 11],
		['দুবার পৌঁছাল', 14],
		['provider call', 15]
	])
);
for (const policy of policies) {
	const random = mulberry32(SEED);
	const call = (): Outcome => {
		const r = random();
		return r < FAIL ? 'fail' : r < FAIL + TIMEOUT ? 'timeout' : 'ok';
	};
	let missing = 0;
	let twice = 0;
	let calls = 0;
	for (let m = 0; m < MESSAGES; m++) {
		let deliveredPrimary = 0;
		let deliveredSecondary = 0;
		for (let attempt = 0; attempt < 6; attempt++) {
			calls++;
			const outcome = call();
			const useSecondary = policy.failover && attempt > 0;
			const sent = outcome === 'ok' || (outcome === 'timeout' && random() < SENT_ON_TIMEOUT);
			if (sent) {
				if (useSecondary) deliveredSecondary = 1;
				else if (policy.key) deliveredPrimary = 1;
				else deliveredPrimary++;
			}
			if (outcome === 'ok' || !policy.retry) break;
		}
		const copies = deliveredPrimary + deliveredSecondary;
		if (copies === 0) missing++;
		if (copies > 1) twice++;
	}
	console.log(
		row([
			[policy.name, 52],
			[pct(missing, MESSAGES, 2), 11],
			[pct(twice, MESSAGES, 2), 14],
			[(calls / MESSAGES).toFixed(3), 15]
		])
	);
}

heading(`অংশ খ — প্রধান email provider ${OUTAGE_S / 60} মিনিট বন্ধ, ${n(RATE)} email/s`);
console.log(
	row([
		['নীতি', 52],
		['দেরি p50', 11],
		['দেরি p99', 11],
		['প্রধানে চেষ্টা', 15]
	])
);
const outagePolicies: [string, 'backoff' | 'breaker'][] = [
	[`একই provider এ exponential backoff (সর্বোচ্চ ${CAP_S / 60} মিনিট)`, 'backoff'],
	[`breaker: ${BREAKER_S} s ব্যর্থতার পরে দ্বিতীয় provider`, 'breaker']
];
for (const [name, mode] of outagePolicies) {
	const random = mulberry32(SEED + 1);
	const delays: number[] = [];
	let primaryAttempts = 0;
	const total = RATE * OUTAGE_S;
	for (let i = 0; i < total; i += 50) {
		const createdAt = (i / total) * OUTAGE_S;
		if (mode === 'breaker' && createdAt >= BREAKER_S) {
			delays.push(0.5);
			continue;
		}
		let t = createdAt;
		let wait = 1;
		for (;;) {
			primaryAttempts += 50;
			if (mode === 'breaker' && t >= BREAKER_S) break;
			if (t >= OUTAGE_S) break;
			t += wait * (0.5 + random() / 2);
			wait = Math.min(CAP_S, wait * 2);
		}
		delays.push(t - createdAt + 0.5);
	}
	delays.sort((a, b) => a - b);
	console.log(
		row([
			[name, 52],
			[ms(percentile(delays, 50) * 1_000), 11],
			[ms(percentile(delays, 99) * 1_000), 11],
			[n(primaryAttempts), 15]
		])
	);
}
console.log('\nদেরি = email তৈরি থেকে পাঠানো পর্যন্ত। Backoff এ jitter আছে (৫০–১০০%)।');
