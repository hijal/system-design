import { keyspace } from './base62';
import { big, bytes, env, heading, n, row, share } from './util';

const NEW_PER_MONTH = env('NEW_PER_MONTH', 100_000_000);
const READ_RATIO = env('READ_RATIO', 100);
const PEAK = env('PEAK', 3);
const YEARS = env('YEARS', 10);
const ROW_BYTES = env('ROW_BYTES', 500);
const RESPONSE_BYTES = env('RESPONSE_BYTES', 500);
const EVENT_BYTES = env('EVENT_BYTES', 100);
const RESTORE_MB_S = env('RESTORE_MB_S', 250);
const PG_INSERTS_PER_S = env('PG_INSERTS_PER_S', 5_000);

const SECONDS_PER_MONTH = 30 * 86_400;
const perYear = NEW_PER_MONTH * 12;
const total = perYear * YEARS;
const writes = NEW_PER_MONTH / SECONDS_PER_MONTH;
const reads = writes * READ_RATIO;

heading(
	`অংশ ক — traffic: মাসে ${big(NEW_PER_MONTH)} নতুন link, পড়া:লেখা = ${READ_RATIO}:1, peak গড়ের ${PEAK} গুণ`
);
console.log(
	row([
		['', 34],
		['গড়', 14],
		['peak', 14]
	]) + '   মন্তব্য'
);
console.log(
	row([
		['নতুন link (লেখা) / s', 34],
		[writes.toFixed(1), 14],
		[(writes * PEAK).toFixed(0), 14]
	]) + '   নিচে Postgres এর ক্ষমতার সাথে তুলনা'
);
console.log(
	row([
		['redirect (পড়া) / s', 34],
		[n(reads), 14],
		[n(reads * PEAK), 14]
	]) + '   এখানেই আসল চাপ — cache এর কাজ'
);
console.log(
	row([
		['redirect এর bandwidth', 34],
		[`${bytes(reads * RESPONSE_BYTES)}/s`, 14],
		[`${bytes(reads * PEAK * RESPONSE_BYTES)}/s`, 14]
	]) + '   response ছোট — network সমস্যা না'
);
console.log(
	row([
		['click event / মাস', 34],
		[big(NEW_PER_MONTH * READ_RATIO), 14],
		[bytes(NEW_PER_MONTH * READ_RATIO * EVENT_BYTES), 14]
	]) + `   event প্রতি ${EVENT_BYTES} B — analytics এর data`
);
console.log(
	`\nPeak এর লেখা একটা Postgres এর আনুমানিক ক্ষমতার (${n(PG_INSERTS_PER_S)} insert/s, ধরে নেওয়া) ${share((writes * PEAK) / PG_INSERTS_PER_S, 1)}`
);

heading(
	`অংশ খ — storage: ${YEARS} বছর, প্রতি row ${ROW_BYTES} B (URL + code + owner + সময় + index, আনুমানিক)`
);
console.log(
	row([
		['', 34],
		['link', 16],
		['জায়গা', 12]
	])
);
console.log(
	row([
		['এক বছর', 34],
		[big(perYear), 16],
		[bytes(perYear * ROW_BYTES), 12]
	])
);
console.log(
	row([
		[`${YEARS} বছর`, 34],
		[big(total), 16],
		[bytes(total * ROW_BYTES), 12]
	])
);
const restoreHours = (total * ROW_BYTES) / (RESTORE_MB_S * 1e6) / 3_600;
console.log(
	`\n${YEARS} বছরের data একটা node থেকে restore করতে (${RESTORE_MB_S} MB/s): ~${restoreHours.toFixed(1)} ঘণ্টা`
);

heading(`অংশ গ — keyspace: base62, বছরে ${big(perYear)} নতুন code`);
console.log(
	row([
		['দৈর্ঘ্য', 8],
		['মোট code', 18],
		['ভরতে কত বছর', 14],
		[`${YEARS} বছরে ভরা`, 14],
		['random: retry লাগে', 20],
		['অনুমানে মেলে', 14]
	])
);
for (const length of [5, 6, 7, 8]) {
	const size = keyspace(length);
	const fill = Math.min(1, total / size);
	const years = size / perYear;
	console.log(
		row([
			[length, 8],
			[big(size), 18],
			[years < 1 ? `${(years * 12).toFixed(0)} মাস` : n(years), 14],
			[share(fill, fill < 0.01 ? 3 : 1), 14],
			[fill >= 1 ? 'ভরে গেছে' : share(fill, fill < 0.01 ? 3 : 1), 20],
			[fill >= 1 ? '100%' : share(fill, fill < 0.01 ? 3 : 1), 14]
		])
	);
}
console.log('\n"random: retry লাগে" = নতুন random code আগে থেকে নেওয়া থাকার সম্ভাবনা = যতটা ভরা।');
console.log(
	'"অনুমানে মেলে" = কেউ একটা random code বানিয়ে চেষ্টা করলে সেটা কোনো আসল link হওয়ার সম্ভাবনা।'
);

heading('অংশ ঘ — যে যন্ত্রগুলোর কথা মনে আসে, তাদের দাম এই মাপে');
const bloomBits = (-total * Math.log(0.01)) / (Math.LN2 * Math.LN2);
console.log(
	row([
		['যন্ত্র', 52],
		['মাপ', 14]
	]) + '   মন্তব্য'
);
console.log(
	row([
		[`Bloom filter, সব ${big(total)} code, ১% ভুল`, 52],
		[bytes(bloomBits / 8), 14]
	]) + '   "code নেওয়া কিনা" — counter এ প্রশ্নটাই ওঠে না'
);
console.log(
	row([
		['HyperLogLog (dense, 12 KB) প্রতি link এ', 52],
		[bytes(total * 12 * 1024), 14]
	]) + '   বেশিরভাগ link এ কয়েকটা click মাত্র'
);
console.log(
	row([
		['Sharding: peak লেখা / একটা primary', 52],
		[share((writes * PEAK) / PG_INSERTS_PER_S, 1), 14]
	]) + '   লেখার জন্য shard লাগে না'
);
console.log(
	row([
		['Sharding: মোট data / ২ TB এর একটা আরামদায়ক node', 52],
		[`${((total * ROW_BYTES) / 2e12).toFixed(1)}×`, 14]
	]) + '   এক দশকে storage আর restore এর জন্য — লেখার জন্য না'
);
