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

heading(`Part A - load: ${big(PAYMENTS_PER_DAY)} payments a day, $${AVG_USD} on average`);
const line = (label: string, value: string, note = ''): void =>
	console.log(
		row([
			[label, 50],
			[value, 18]
		]) + (note === '' ? '' : `   ${note}`)
	);
line('payments / s (average)', avg.toFixed(0));
line(`payments / s (on a sale day, ${PEAK}×)`, n(avg * PEAK), 'small for a Postgres');
line('money per day', `$${big(volume)}`);
line('per year', `$${big(volume * 365)}`);

heading('Part B - the price of mistakes: how much error is how much money');
console.log(
	row([
		['error rate', 50],
		['per day', 18],
		['per year', 18]
	])
);
for (const rate of [0.01, 0.001, 0.0001, 0.00001]) {
	console.log(
		row([
			[`mistakes on ${rate * 100}% of payments`, 50],
			[`$${n(volume * rate)}`, 18],
			[`$${big(volume * rate * 365)}`, 18]
		])
	);
}
console.log(
	'a "double charge" is not just money - it is a chargeback, an angry customer, and your record with the card network.'
);

heading(
	`Part C - ledger: ${ENTRIES_PER_PAYMENT} entries per payment (authorize, capture, fee, payout…)`
);
const entries = PAYMENTS_PER_DAY * ENTRIES_PER_PAYMENT;
line('entries per day', big(entries));
line(
	`kept ${YEARS} years (legal)`,
	big(entries * 365 * YEARS),
	bytes(entries * 365 * YEARS * ENTRY_BYTES)
);

heading(
	`Part D - where the money of one $${AVG_USD} payment goes (fee ${(FEE_SHARE * 100).toFixed(1)}% + $${FEE_FIXED}, approximate)`
);
const fee = AVG_USD * FEE_SHARE + FEE_FIXED;
line('the customer paid', `$${AVG_USD.toFixed(2)}`);
line('processing fee', `$${fee.toFixed(2)}`, `${((fee / AVG_USD) * 100).toFixed(1)}%`);
line('the merchant gets', `$${(AVG_USD - fee).toFixed(2)}`, 'a few days later, in the payout');
console.log(
	'every step is a pair of entries in the ledger - money is never created or destroyed, it only moves from one account to another.'
);
