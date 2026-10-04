import { big, bytes, env, heading, n, row } from './util';

const PAYMENTS_PER_DAY = env('PAYMENTS_PER_DAY', 10_000_000);
const AVG_USD = env('AVG_USD', 30);
const PEAK = env('PEAK', 10);
const ENTRIES_PER_PAYMENT = env('ENTRIES_PER_PAYMENT', 6);
const ENTRY_BYTES = env('ENTRY_BYTES', 200);
const YEARS = env('YEARS', 7);
const FEE_SHARE = env('FEE_SHARE', 0.029);
const FEE_FIXED = env('FEE_FIXED', 0.3);

const DAY = 86_400;
const avg = PAYMENTS_PER_DAY / DAY;
const volume = PAYMENTS_PER_DAY * AVG_USD;

heading(`অংশ ক — চাপ: দিনে ${big(PAYMENTS_PER_DAY)} payment, গড় $${AVG_USD}`);
const line = (label: string, value: string, note = ''): void =>
	console.log(
		row([
			[label, 50],
			[value, 18]
		]) + (note === '' ? '' : `   ${note}`)
	);
line('payment / s (গড়)', avg.toFixed(0));
line(`payment / s (sale এর দিনে, ${PEAK}×)`, n(avg * PEAK), 'একটা Postgres এর জন্য ছোট');
line('দিনে টাকার পরিমাণ', `$${big(volume)}`);
line('বছরে', `$${big(volume * 365)}`);

heading('অংশ খ — ভুলের দাম: কতটা ভুল কতটা টাকা');
console.log(
	row([
		['ভুলের হার', 50],
		['দিনে', 18],
		['বছরে', 18]
	])
);
for (const rate of [0.01, 0.001, 0.0001, 0.00001]) {
	console.log(
		row([
			[`${rate * 100}% payment এ ভুল`, 50],
			[`$${n(volume * rate)}`, 18],
			[`$${big(volume * rate * 365)}`, 18]
		])
	);
}
console.log(
	'একটা "দুবার কাটা" শুধু টাকা না — একটা chargeback, একটা রাগী customer, আর card network এর কাছে তোমার হিসাব।'
);

heading(
	`অংশ গ — ledger: payment প্রতি ${ENTRIES_PER_PAYMENT}টা entry (authorize, capture, fee, payout…)`
);
const entries = PAYMENTS_PER_DAY * ENTRIES_PER_PAYMENT;
line('দিনে entry', big(entries));
line(
	`${YEARS} বছর রাখা (আইনি)`,
	big(entries * 365 * YEARS),
	bytes(entries * 365 * YEARS * ENTRY_BYTES)
);

heading(
	`অংশ ঘ — একটা $${AVG_USD} payment এর টাকা কোথায় যায় (fee ${(FEE_SHARE * 100).toFixed(1)}% + $${FEE_FIXED}, আনুমানিক)`
);
const fee = AVG_USD * FEE_SHARE + FEE_FIXED;
line('customer দিল', `$${AVG_USD.toFixed(2)}`);
line('processing fee', `$${fee.toFixed(2)}`, `${((fee / AVG_USD) * 100).toFixed(1)}%`);
line('merchant পাবে', `$${(AVG_USD - fee).toFixed(2)}`, 'কয়েক দিন পরে, payout এ');
console.log(
	'প্রতিটা ধাপ ledger এ একটা জোড়া entry — টাকা কখনো তৈরি বা ধ্বংস হয় না, শুধু এক account থেকে আরেকটায় যায়।'
);
