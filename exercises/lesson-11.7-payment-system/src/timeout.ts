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
	{ name: 'timeout = failed, let the user try again', mode: 'fail' },
	{ name: 'resend it ourselves, a new request', mode: 'retry-new' },
	{ name: 'resend it ourselves, the same idempotency key', mode: 'retry-key' },
	{ name: 'keep "unknown": webhook, else ask for the status', mode: 'unknown' }
];

heading(
	`Part A — ${n(PAYMENTS)} payments: ${DECLINE * 100}% declined, ${TIMEOUT * 100}% time out (${CHARGED_ON_TIMEOUT * 100}% of those were actually charged)`
);
console.log(
	row([
		['policy', 52],
		['charged twice', 15],
		['charged, no order', 19],
		['wait p99', 13]
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
			[policy.name, 52],
			[n(doubles), 15],
			[n(orphans), 19],
			[waits.length === 0 ? '—' : `${percentile(waits, 99).toFixed(0)} s`, 13]
		])
	);
}
console.log(
	'"charged, no order" = the customer\'s money was taken, but we treated the payment as failed — unless someone finds it, this is theft.'
);

heading(`Part B — the process dies (${CRASH * 100}% at each step): which order to write in`);
console.log(
	row([
		['order', 60],
		['charged, we have no record', 28],
		['recovery finds', 20]
	])
);
for (const [name, intentFirst] of [
	['charge at the PSP → then write the payment to the DB', false],
	['intent in the DB (created) → PSP → the result in the DB', true]
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
			[name, 60],
			[n(invisible), 28],
			[n(recovered), 20]
		])
	);
}
console.log(
	'"recovery" = a job that asks the PSP, by idempotency key (payment id), about payments left in the "created" state.'
);
console.log(
	'whatever is still left after that is caught by the end-of-day reconciliation — `npm run reconcile`.'
);
