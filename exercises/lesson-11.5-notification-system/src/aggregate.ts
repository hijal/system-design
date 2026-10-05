import { env, exponential, heading, ms, mulberry32, n, pct, row } from './util';

const SEED = env('SEED', 11);
const LIKES = env('LIKES', 500);
const DECAY_S = env('DECAY_S', 180);
const CAP_WINDOW_S = env('CAP_WINDOW_S', 300);
const BATCH_S = env('BATCH_S', 30);
const USERS = env('USERS', 1_000_000);
const PER_USER_DAY = env('PER_USER_DAY', 10);
const NIGHT_SHARE = env('NIGHT_SHARE', 9 / 24);
const CRITICAL_SHARE = env('CRITICAL_SHARE', 0.05);

const random = mulberry32(SEED);
const times: number[] = [];
for (let i = 0; i < LIKES; i++) times.push(exponential(random, DECAY_S));
times.sort((a, b) => a - b);

heading(`Part A — someone's post went viral: ${n(LIKES)} likes, most in the first few minutes`);
console.log(
	row([
		['policy', 62],
		['push', 8],
		['first one at', 13],
		['last like reported', 28]
	])
);

const each = times.length;
const firstLike = times[0] ?? 0;
const lastLike = times[times.length - 1] ?? 0;
console.log(
	row([
		['one push per like', 62],
		[n(each), 8],
		[ms(firstLike * 1_000), 13],
		['immediately', 28]
	])
);

let capped = 0;
let nextAllowed = 0;
let lastCapped = 0;
for (const t of times)
	if (t >= nextAllowed) {
		capped++;
		lastCapped = t;
		nextAllowed = t + CAP_WINDOW_S;
	}
console.log(
	row([
		[`at most one per ${CAP_WINDOW_S / 60} minutes, drop the rest`, 62],
		[n(capped), 8],
		[ms(firstLike * 1_000), 13],
		[`no (last ${ms((lastLike - lastCapped) * 1_000)} dropped)`, 28]
	])
);

let batched = 0;
let windowEnd = -1;
let lastSent = 0;
let firstSent = -1;
for (const t of times) {
	if (t > windowEnd) {
		windowEnd = t + BATCH_S;
		batched++;
		lastSent = windowEnd;
		if (firstSent < 0) firstSent = windowEnd;
	}
}
console.log(
	row([
		[`batch in a ${BATCH_S} s window, "X and N others" (collapse key)`, 62],
		[n(batched), 8],
		[ms(firstSent * 1_000), 13],
		[`${ms((lastSent - lastLike) * 1_000)} later`, 28]
	])
);

let adaptive = 0;
let gate = -1;
let wait = BATCH_S;
let firstAdaptive = -1;
for (const t of times) {
	if (t > gate) {
		const sendAt = adaptive === 0 ? t : t + wait;
		adaptive++;
		if (firstAdaptive < 0) firstAdaptive = sendAt;
		gate = sendAt;
		wait = Math.min(3_600, wait * 2);
	}
}
console.log(
	row([
		['first one at once, then the window doubles (30 s, 1, 2… min)', 62],
		[n(adaptive), 8],
		[ms(firstAdaptive * 1_000), 13],
		[`${ms((gate - lastLike) * 1_000)} later`, 28]
	])
);
console.log(
	'"collapse key" = on the device, the old notification with the same key is replaced by the new one instead of piling up.'
);

heading(
	`Part B — night-time quiet (10 pm–7 am): ${n(USERS)} users × ${PER_USER_DAY} a day, ${pct(CRITICAL_SHARE, 1, 0)} urgent (OTP, security)`
);
const total = USERS * PER_USER_DAY;
const night = total * NIGHT_SHARE;
const deferred = night * (1 - CRITICAL_SHARE);
console.log(
	row([
		['created at night', 34],
		[n(night), 14]
	])
);
console.log(
	row([
		['held until 7 am', 34],
		[n(deferred), 14]
	])
);
console.log(
	row([
		['average delay (if evenly spread)', 34],
		['4.5 h', 14]
	])
);
console.log(
	`${n(deferred)} at once at 7 am — a wave at 7 in every time zone. Spread them (random within 7:00–7:30), or this becomes a campaign of its own.`
);
