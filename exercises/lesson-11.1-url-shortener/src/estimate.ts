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
	`Part A — traffic: ${big(NEW_PER_MONTH)} new links a month, read:write = ${READ_RATIO}:1, peak ${PEAK}× the average`
);
console.log(
	row([
		['', 34],
		['average', 14],
		['peak', 14]
	]) + '   note'
);
console.log(
	row([
		['new links (writes) / s', 34],
		[writes.toFixed(1), 14],
		[(writes * PEAK).toFixed(0), 14]
	]) + '   compared with Postgres capacity below'
);
console.log(
	row([
		['redirects (reads) / s', 34],
		[n(reads), 14],
		[n(reads * PEAK), 14]
	]) + "   the real load is here — the cache's job"
);
console.log(
	row([
		['redirect bandwidth', 34],
		[`${bytes(reads * RESPONSE_BYTES)}/s`, 14],
		[`${bytes(reads * PEAK * RESPONSE_BYTES)}/s`, 14]
	]) + '   small responses — not a network problem'
);
console.log(
	row([
		['click events / month', 34],
		[big(NEW_PER_MONTH * READ_RATIO), 14],
		[bytes(NEW_PER_MONTH * READ_RATIO * EVENT_BYTES), 14]
	]) + `   ${EVENT_BYTES} B per event — analytics data`
);
console.log(
	`\nPeak writes are ${share((writes * PEAK) / PG_INSERTS_PER_S, 1)} of one Postgres's approximate capacity (${n(PG_INSERTS_PER_S)} inserts/s, assumed)`
);

heading(
	`Part B — storage: ${YEARS} years, ${ROW_BYTES} B per row (URL + code + owner + time + index, approximate)`
);
console.log(
	row([
		['', 34],
		['link', 16],
		['space', 12]
	])
);
console.log(
	row([
		['one year', 34],
		[big(perYear), 16],
		[bytes(perYear * ROW_BYTES), 12]
	])
);
console.log(
	row([
		[`${YEARS} years`, 34],
		[big(total), 16],
		[bytes(total * ROW_BYTES), 12]
	])
);
const restoreHours = (total * ROW_BYTES) / (RESTORE_MB_S * 1e6) / 3_600;
console.log(
	`\nRestoring ${YEARS} years of data to one node (${RESTORE_MB_S} MB/s): ~${restoreHours.toFixed(1)} hours`
);

heading(`Part C — keyspace: base62, ${big(perYear)} new codes a year`);
console.log(
	row([
		['length', 8],
		['total codes', 18],
		['years to fill', 16],
		[`full in ${YEARS} yrs`, 16],
		['random: retry', 20],
		['guess hits', 14]
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
			[years < 1 ? `${(years * 12).toFixed(0)} months` : n(years), 16],
			[share(fill, fill < 0.01 ? 3 : 1), 16],
			[fill >= 1 ? 'full' : share(fill, fill < 0.01 ? 3 : 1), 20],
			[fill >= 1 ? '100%' : share(fill, fill < 0.01 ? 3 : 1), 14]
		])
	);
}
console.log('\n"random: retry" = the chance a new random code is already taken = how full it is.');
console.log(
	'"guess hits" = the chance that a random code someone makes up and tries is a real link.'
);

heading('Part D — the tools that come to mind, and their price at this size');
const bloomBits = (-total * Math.log(0.01)) / (Math.LN2 * Math.LN2);
console.log(
	row([
		['tool', 52],
		['size', 14]
	]) + '   note'
);
console.log(
	row([
		[`Bloom filter, all ${big(total)} codes, 1% error`, 52],
		[bytes(bloomBits / 8), 14]
	]) + '   "is the code taken" — with a counter the question never comes up'
);
console.log(
	row([
		['HyperLogLog (dense, 12 KB) per link', 52],
		[bytes(total * 12 * 1024), 14]
	]) + '   most links get only a few clicks'
);
console.log(
	row([
		['Sharding: peak writes / one primary', 52],
		[share((writes * PEAK) / PG_INSERTS_PER_S, 1), 14]
	]) + '   no shards needed for writes'
);
console.log(
	row([
		['Sharding: total data / one comfortable 2 TB node', 52],
		[`${((total * ROW_BYTES) / 2e12).toFixed(1)}×`, 14]
	]) + '   for storage and restore over a decade — not for writes'
);
