import { big, bytes, env, heading, n, pct, row } from './util';

const DAU = env('DAU', 300_000_000);
const PER_USER = env('PER_USER', 10);
const PEAK = env('PEAK', 3);
const PUSH_SHARE = env('PUSH_SHARE', 0.8);
const EMAIL_SHARE = env('EMAIL_SHARE', 0.17);
const SMS_SHARE = env('SMS_SHARE', 0.01);
const INAPP_SHARE = env('INAPP_SHARE', 0.02);
const PUSH_COST = env('PUSH_COST', 0);
const EMAIL_COST = env('EMAIL_COST', 0.0001);
const SMS_COST = env('SMS_COST', 0.008);
const CAMPAIGN = env('CAMPAIGN', 100_000_000);
const CAMPAIGN_HOURS = env('CAMPAIGN_HOURS', 1);
const TOKENS = env('TOKENS', 900_000_000);
const STALE_SHARE = env('STALE_SHARE', 0.3);
const EVENT_BYTES = env('EVENT_BYTES', 500);
const RETENTION_DAYS = env('RETENTION_DAYS', 90);

const DAY = 86_400;
const MONTH = 30;
const perDay = DAU * PER_USER;
const avg = perDay / DAY;

heading(`অংশ ক — চাপ: ${big(DAU)} DAU, user প্রতি দিনে ${PER_USER}টা notification`);
console.log(
	row([
		['', 46],
		['গড়/s', 14],
		[`peak/s (${PEAK}×)`, 16]
	])
);
console.log(
	row([
		['সব notification', 46],
		[n(avg), 14],
		[n(avg * PEAK), 16]
	])
);
const campaignRate = CAMPAIGN / (CAMPAIGN_HOURS * 3_600);
console.log(
	row([
		[`একটা campaign: ${big(CAMPAIGN)} জন, ${CAMPAIGN_HOURS} ঘণ্টায়`, 46],
		[n(campaignRate), 14],
		[`${(campaignRate / avg).toFixed(1)}× গড়`, 16]
	])
);

heading(`অংশ খ — channel আর মাসিক খরচ (আনুমানিক দাম)`);
console.log(
	row([
		['channel', 18],
		['ভাগ', 8],
		['দিনে', 16],
		['প্রতিটা', 12],
		['মাসে', 14],
		['খরচের ভাগ', 12]
	])
);
const channels: [string, number, number][] = [
	['push (APNs/FCM)', PUSH_SHARE, PUSH_COST],
	['email', EMAIL_SHARE, EMAIL_COST],
	['SMS', SMS_SHARE, SMS_COST],
	['in-app', INAPP_SHARE, 0]
];
const monthly = channels.map(([, share, cost]) => perDay * share * cost * MONTH);
const total = monthly.reduce((a, b) => a + b, 0);
channels.forEach(([name, share, cost], i) => {
	console.log(
		row([
			[name, 18],
			[pct(share, 1, 0), 8],
			[big(perDay * share), 16],
			[cost === 0 ? '$0' : `$${cost}`, 12],
			[`$${n(monthly[i] ?? 0)}`, 14],
			[pct(monthly[i] ?? 0, total, 1), 12]
		])
	);
});
console.log(
	`SMS এর ${pct(SMS_SHARE, 1, 0)} notification থেকে খরচের ${pct(monthly[2] ?? 0, total, 0)} — একটা OTP push এ গেলে বাঁচে।`
);

heading(
	`অংশ গ — device token: ${big(TOKENS)} token, ${pct(STALE_SHARE, 1, 0)} মরা (app মুছে ফেলা, ফোন বদলানো)`
);
const pushPerDay = perDay * PUSH_SHARE;
console.log(
	`প্রতি user এর সব token এ পাঠালে দিনে ${big(pushPerDay * (TOKENS / DAU))} push, তার ${big(pushPerDay * (TOKENS / DAU) * STALE_SHARE)} মরা token এ`
);
console.log(
	'APNs/FCM মরা token এ "unregistered" ফেরত দেয় — সেটা পড়ে token মুছে না ফেললে এই অপচয় প্রতিদিন বাড়ে।'
);

heading(`অংশ ঘ — প্রতিটা notification এর ইতিহাস (${EVENT_BYTES} B, ${RETENTION_DAYS} দিন)`);
console.log(
	`দিনে ${bytes(perDay * EVENT_BYTES)}, ${RETENTION_DAYS} দিনে ${bytes(perDay * EVENT_BYTES * RETENTION_DAYS)} — "কেন পেলাম/পেলাম না" এর উত্তর আর dedupe এর জন্য`
);
