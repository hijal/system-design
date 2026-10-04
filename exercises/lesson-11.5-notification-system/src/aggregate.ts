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

heading(`অংশ ক — একজনের post viral: ${n(LIKES)}টা like, বেশিরভাগ প্রথম কয়েক মিনিটে`);
console.log(
	row([
		['নীতি', 54],
		['push', 8],
		['প্রথমটা কখন', 13],
		['শেষ like জানানো হলো', 22]
	])
);

const each = times.length;
const firstLike = times[0] ?? 0;
const lastLike = times[times.length - 1] ?? 0;
console.log(
	row([
		['প্রতিটা like এ একটা push', 54],
		[n(each), 8],
		[ms(firstLike * 1_000), 13],
		['সাথে সাথে', 22]
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
		[`প্রতি ${CAP_WINDOW_S / 60} মিনিটে সর্বোচ্চ একটা, বাকি ফেলে দাও`, 54],
		[n(capped), 8],
		[ms(firstLike * 1_000), 13],
		[`না (শেষ ${ms((lastLike - lastCapped) * 1_000)} বাদ)`, 22]
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
		[`${BATCH_S} s এর জানালায় জমিয়ে "X আর আরও N জন" (collapse key)`, 54],
		[n(batched), 8],
		[ms(firstSent * 1_000), 13],
		[`${ms((lastSent - lastLike) * 1_000)} পরে`, 22]
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
		['প্রথমটা সাথে সাথে, তারপর জানালা দ্বিগুণ হয় (৩০ s, ১, ২… মি)', 54],
		[n(adaptive), 8],
		[ms(firstAdaptive * 1_000), 13],
		[`${ms((gate - lastLike) * 1_000)} পরে`, 22]
	])
);
console.log(
	'"collapse key" = device এ একই key এর পুরনো notification নতুনটা দিয়ে বদলে যায়, স্তূপ হয় না।'
);

heading(
	`অংশ খ — রাতের নীরবতা (রাত ১০টা–সকাল ৭টা): ${n(USERS)} user × দিনে ${PER_USER_DAY}টা, ${pct(CRITICAL_SHARE, 1, 0)} জরুরি (OTP, নিরাপত্তা)`
);
const total = USERS * PER_USER_DAY;
const night = total * NIGHT_SHARE;
const deferred = night * (1 - CRITICAL_SHARE);
console.log(
	row([
		['রাতে তৈরি', 30],
		[n(night), 14]
	])
);
console.log(
	row([
		['সকাল ৭টা পর্যন্ত ধরে রাখা', 30],
		[n(deferred), 14]
	])
);
console.log(
	row([
		['গড় দেরি (সমান ভাবে ছড়ানো ধরে)', 30],
		['4.5 ঘ', 14]
	])
);
console.log(
	`সকাল ৭টায় একসাথে ${n(deferred)}টা — প্রতিটা time zone এর ৭টায় একটা ঢেউ। ছড়িয়ে দাও (৭:০০–৭:৩০ এ এলোমেলো), নইলে এটাই নিজের campaign।`
);
