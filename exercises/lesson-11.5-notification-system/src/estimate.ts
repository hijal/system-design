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

heading(`Part A — load: ${big(DAU)} DAU, ${PER_USER} notifications a day per user`);
console.log(
	row([
		['', 46],
		['average/s', 14],
		[`peak/s (${PEAK}×)`, 16]
	])
);
console.log(
	row([
		['all notifications', 46],
		[n(avg), 14],
		[n(avg * PEAK), 16]
	])
);
const campaignRate = CAMPAIGN / (CAMPAIGN_HOURS * 3_600);
console.log(
	row([
		[`one campaign: ${big(CAMPAIGN)} people, in ${CAMPAIGN_HOURS} h`, 46],
		[n(campaignRate), 14],
		[`${(campaignRate / avg).toFixed(1)}× the average`, 20]
	])
);

heading(`Part B — channels and monthly cost (approximate prices)`);
console.log(
	row([
		['channel', 18],
		['share', 8],
		['per day', 16],
		['each', 12],
		['monthly', 14],
		['share of cost', 15]
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
			[pct(monthly[i] ?? 0, total, 1), 15]
		])
	);
});
console.log(
	`SMS: ${pct(SMS_SHARE, 1, 0)} of notifications, ${pct(monthly[2] ?? 0, total, 0)} of the cost — every OTP sent by push instead is a saving.`
);

heading(
	`Part C — device tokens: ${big(TOKENS)} tokens, ${pct(STALE_SHARE, 1, 0)} dead (app deleted, phone changed)`
);
const pushPerDay = perDay * PUSH_SHARE;
console.log(
	`sending to every token of every user is ${big(pushPerDay * (TOKENS / DAU))} pushes a day, ${big(pushPerDay * (TOKENS / DAU) * STALE_SHARE)} of them to dead tokens`
);
console.log(
	'APNs/FCM return "unregistered" for a dead token — if you don\'t read that and delete the token, this waste grows every day.'
);

heading(`Part D — the history of every notification (${EVENT_BYTES} B, ${RETENTION_DAYS} days)`);
console.log(
	`${bytes(perDay * EVENT_BYTES)} a day, ${bytes(perDay * EVENT_BYTES * RETENTION_DAYS)} over ${RETENTION_DAYS} days — for answering "why did/didn't I get it" and for dedupe`
);
