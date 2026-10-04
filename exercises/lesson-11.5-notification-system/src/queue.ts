import { env, heading, ms, mulberry32, n, percentile, row } from './util';

const SEED = env('SEED', 11);
const OTP_PER_S = env('OTP_PER_S', 20);
const PROVIDER_PER_S = env('PROVIDER_PER_S', 100);
const CAMPAIGN = env('CAMPAIGN', 300_000);
const CAMPAIGN_AT_S = env('CAMPAIGN_AT_S', 60);
const PACE_SHARE = env('PACE_SHARE', 0.5);
const OTP_VALID_S = env('OTP_VALID_S', 300);
const SECONDS = env('SECONDS', 7_200);
const TICK_MS = env('TICK_MS', 100);

type Kind = 'otp' | 'campaign';
interface Item {
	kind: Kind;
	at: number;
}

type Policy = {
	name: string;
	order: 'fifo' | 'priority';
	paced: boolean;
	separate: boolean;
};

const policies: Policy[] = [
	{ name: 'একটা FIFO queue, একটা provider account', order: 'fifo', paced: false, separate: false },
	{
		name: `FIFO, কিন্তু campaign ঢোকে ধীরে (সীমার ${PACE_SHARE * 100}%)`,
		order: 'fifo',
		paced: true,
		separate: false
	},
	{
		name: 'অগ্রাধিকার: OTP আগে, campaign বাকিটা',
		order: 'priority',
		paced: false,
		separate: false
	},
	{
		name: 'আলাদা account: OTP আর campaign এর আলাদা সীমা',
		order: 'priority',
		paced: false,
		separate: true
	}
];

heading(
	`SMS provider এর সীমা ${PROVIDER_PER_S}/s; OTP ${OTP_PER_S}/s; ${CAMPAIGN_AT_S} s এ ${n(CAMPAIGN)}টা marketing SMS এর campaign; OTP এর মেয়াদ ${OTP_VALID_S / 60} মিনিট`
);
console.log(
	row([
		['নীতি', 50],
		['OTP p50', 10],
		['OTP p99', 10],
		['সবচেয়ে খারাপ', 13],
		['মেয়াদ পার', 11],
		['campaign শেষ', 14]
	])
);
for (const policy of policies) {
	const random = mulberry32(SEED);
	const otp: Item[] = [];
	const campaign: Item[] = [];
	const fifo: Item[] = [];
	const delays: number[] = [];
	let expired = 0;
	let campaignLeft = CAMPAIGN;
	let campaignQueued = 0;
	let campaignDone = -1;
	const perTick = (PROVIDER_PER_S * TICK_MS) / 1_000;
	let credit = 0;
	let campaignCredit = 0;
	for (let t = 0; t < (SECONDS * 1_000) / TICK_MS; t++) {
		const now = t * TICK_MS;
		const arrivals = Math.floor((OTP_PER_S * TICK_MS) / 1_000 + random());
		for (let i = 0; i < arrivals; i++) {
			const item: Item = { kind: 'otp', at: now };
			if (policy.order === 'fifo') fifo.push(item);
			else otp.push(item);
		}
		if (now >= CAMPAIGN_AT_S * 1_000 && campaignLeft > 0) {
			let release = campaignLeft;
			if (policy.paced) {
				campaignCredit += perTick * PACE_SHARE;
				release = Math.min(campaignLeft, Math.floor(campaignCredit));
				campaignCredit -= release;
			}
			campaignLeft -= release;
			campaignQueued += release;
			for (let i = 0; i < release; i++) {
				const item: Item = { kind: 'campaign', at: now };
				if (policy.order === 'fifo') fifo.push(item);
				else campaign.push(item);
			}
		}
		const end = now + TICK_MS;
		const deliver = (item: Item): void => {
			if (item.kind === 'otp') {
				const delay = end - item.at;
				delays.push(delay);
				if (delay > OTP_VALID_S * 1_000) expired++;
			} else if (--campaignQueued === 0 && campaignLeft === 0) campaignDone = end;
		};
		credit += perTick;
		let budget = Math.floor(credit);
		credit -= budget;
		if (policy.separate) {
			const otpSent = otp.splice(0, budget);
			otpSent.forEach(deliver);
			campaign.splice(0, budget).forEach(deliver);
			budget = 0;
		}
		let head = 0;
		if (policy.order === 'fifo') {
			while (budget > 0 && head < fifo.length) {
				const item = fifo[head++];
				if (item !== undefined) deliver(item);
				budget--;
			}
			fifo.splice(0, head);
		} else if (budget > 0) {
			const fromOtp = otp.splice(0, budget);
			fromOtp.forEach(deliver);
			campaign.splice(0, budget - fromOtp.length).forEach(deliver);
		}
	}
	delays.sort((a, b) => a - b);
	console.log(
		row([
			[policy.name, 50],
			[ms(percentile(delays, 50)), 10],
			[ms(percentile(delays, 99)), 10],
			[ms(delays[delays.length - 1] ?? 0), 13],
			[n(expired), 11],
			[
				campaignDone < 0
					? `> ${SECONDS / 3_600} ঘ`
					: `${((campaignDone / 1_000 - CAMPAIGN_AT_S) / 60).toFixed(0)} মি`,
				14
			]
		])
	);
}
console.log(
	'\nদেরি ১০০ ms এর ধাপে। "আলাদা account" এ দুই account এর প্রতিটার সীমা একই, তাই মোট ক্ষমতা দ্বিগুণ — সেটাও একটা খরচ।'
);
