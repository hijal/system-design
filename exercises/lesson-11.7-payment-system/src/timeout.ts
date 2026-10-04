import { env, heading, lognormal, mulberry32, n, percentile, row } from './util';

const SEED = env('SEED', 11);
const PAYMENTS = env('PAYMENTS', 1_000_000);
const DECLINE = env('DECLINE', 0.04);
const TIMEOUT = env('TIMEOUT', 0.01);
const CHARGED_ON_TIMEOUT = env('CHARGED_ON_TIMEOUT', 0.6);
const USER_RETRY = env('USER_RETRY', 0.7);
const WEBHOOK_MEDIAN_S = env('WEBHOOK_MEDIAN_S', 5);
const WEBHOOK_LOST = env('WEBHOOK_LOST', 0.01);
const POLL_AFTER_S = env('POLL_AFTER_S', 60);
const CRASH = env('CRASH', 0.001);

type Outcome = 'charged' | 'declined' | 'timeout-charged' | 'timeout-not';

type Policy = { name: string; mode: 'fail' | 'retry-new' | 'retry-key' | 'unknown' };

const policies: Policy[] = [
	{ name: 'timeout = ব্যর্থ, user আবার চেষ্টা করুক', mode: 'fail' },
	{ name: 'নিজে আবার পাঠাও, নতুন request', mode: 'retry-new' },
	{ name: 'নিজে আবার পাঠাও, একই idempotency key', mode: 'retry-key' },
	{ name: '"unknown" রাখো: webhook, না এলে status জিজ্ঞেস', mode: 'unknown' }
];

heading(
	`অংশ ক — ${n(PAYMENTS)} payment: ${DECLINE * 100}% decline, ${TIMEOUT * 100}% timeout (তার ${CHARGED_ON_TIMEOUT * 100}% আসলে কাটা হয়েছিল)`
);
console.log(
	row([
		['নীতি', 48],
		['দুবার কাটা', 12],
		['কাটা, order নেই', 16],
		['অপেক্ষা p99', 13]
	])
);
for (const policy of policies) {
	const random = mulberry32(SEED);
	const call = (): Outcome => {
		const r = random();
		if (r < TIMEOUT) return random() < CHARGED_ON_TIMEOUT ? 'timeout-charged' : 'timeout-not';
		return r < TIMEOUT + DECLINE ? 'declined' : 'charged';
	};
	let doubles = 0;
	let orphans = 0;
	const waits: number[] = [];
	for (let p = 0; p < PAYMENTS; p++) {
		const first = call();
		if (first === 'charged' || first === 'declined') continue;
		const firstCharged = first === 'timeout-charged';
		if (policy.mode === 'fail') {
			if (random() < USER_RETRY) {
				const second = call();
				if (firstCharged && (second === 'charged' || second === 'timeout-charged')) doubles++;
			} else if (firstCharged) orphans++;
		} else if (policy.mode === 'retry-new') {
			const second = call();
			if (firstCharged && (second === 'charged' || second === 'timeout-charged')) doubles++;
		} else if (policy.mode === 'unknown') {
			const lost = random() < WEBHOOK_LOST;
			waits.push(
				lost ? POLL_AFTER_S : Math.min(POLL_AFTER_S, lognormal(random, WEBHOOK_MEDIAN_S, 0.8))
			);
		}
	}
	waits.sort((a, b) => a - b);
	console.log(
		row([
			[policy.name, 48],
			[n(doubles), 12],
			[n(orphans), 16],
			[waits.length === 0 ? '—' : `${percentile(waits, 99).toFixed(0)} s`, 13]
		])
	);
}
console.log(
	'"কাটা, order নেই" = customer এর টাকা কাটা হয়েছে, কিন্তু আমরা payment কে ব্যর্থ ধরেছি — কেউ খুঁজে না পেলে এটা চুরি।'
);

heading(`অংশ খ — process মরে যায় (প্রতি ধাপে ${CRASH * 100}%): কোন ক্রমে লিখব`);
console.log(
	row([
		['ক্রম', 56],
		['কাটা, আমাদের কোনো রেকর্ড নেই', 28],
		['recovery খুঁজে পায়', 20]
	])
);
for (const [name, intentFirst] of [
	['PSP তে charge → তারপর DB তে payment লেখো', false],
	['DB তে intent (created) → PSP → DB তে ফল', true]
] as const) {
	const random = mulberry32(SEED + 3);
	let invisible = 0;
	let recovered = 0;
	for (let p = 0; p < PAYMENTS; p++) {
		if (intentFirst && random() < CRASH) continue;
		const charged = random() >= DECLINE;
		if (random() < CRASH) {
			if (!charged) continue;
			if (intentFirst) recovered++;
			else invisible++;
		}
	}
	console.log(
		row([
			[name, 56],
			[n(invisible), 28],
			[n(recovered), 20]
		])
	);
}
console.log(
	'"recovery" = একটা job যা "created" অবস্থায় পড়ে থাকা payment গুলো PSP তে idempotency key (payment id) দিয়ে জিজ্ঞেস করে।'
);
console.log('এর পরেও যা বাকি থাকে, সেটা ধরে দিনশেষের reconciliation — `npm run reconcile`।');
