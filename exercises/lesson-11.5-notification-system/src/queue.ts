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
	{ name: 'one FIFO queue, one provider account', order: 'fifo', paced: false, separate: false },
	{
		name: `FIFO, but the campaign enters slowly (${PACE_SHARE * 100}% of the limit)`,
		order: 'fifo',
		paced: true,
		separate: false
	},
	{
		name: 'priority: OTP first, the campaign gets the rest',
		order: 'priority',
		paced: false,
		separate: false
	},
	{
		name: 'separate accounts: separate limits for OTP and campaign',
		order: 'priority',
		paced: false,
		separate: true
	}
];

heading(
	`SMS provider limit ${PROVIDER_PER_S}/s; OTP ${OTP_PER_S}/s; a campaign of ${n(CAMPAIGN)} marketing SMS at ${CAMPAIGN_AT_S} s; OTPs expire after ${OTP_VALID_S / 60} minutes`
);
console.log(
	row([
		['policy', 58],
		['OTP p50', 10],
		['OTP p99', 10],
		['worst', 13],
		['expired', 11],
		['campaign done', 15]
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
			[policy.name, 58],
			[ms(percentile(delays, 50)), 10],
			[ms(percentile(delays, 99)), 10],
			[ms(delays[delays.length - 1] ?? 0), 13],
			[n(expired), 11],
			[
				campaignDone < 0
					? `> ${SECONDS / 3_600} h`
					: `${((campaignDone / 1_000 - CAMPAIGN_AT_S) / 60).toFixed(0)} min`,
				14
			]
		])
	);
}
console.log(
	'\ndelay in steps of 100 ms. With "separate accounts" each of the two accounts has the same limit, so total capacity doubles - that is a cost too.'
);
