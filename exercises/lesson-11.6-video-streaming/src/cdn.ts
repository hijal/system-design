import { big, bytes, env, heading, n, pct, row } from './util';

const VIDEOS = env('VIDEOS', 100_000_000);
const ZIPF_S = env('ZIPF_S', 1.2);
const WATCH_HOURS = env('WATCH_HOURS', 6_000_000_000);
const VIDEO_MIN = env('VIDEO_MIN', 10);
const AVG_MBPS = env('AVG_MBPS', 3);
const LADDER_MBPS = env('LADDER_MBPS', 10.4);
const CDN_PER_GB = env('CDN_PER_GB', 0.01);
const H264_PER_HOUR = env('H264_PER_HOUR', 0.08);
const AV1_COST_X = env('AV1_COST_X', 10);
const AV1_SAVING = env('AV1_SAVING', 0.3);

interface Bin {
	count: number;
	hours: number;
}

const bins: Bin[] = [];
{
	let harmonic = 0;
	const raw: [number, number][] = [];
	let start = 1;
	while (start <= VIDEOS) {
		const end = Math.min(VIDEOS, Math.max(start, Math.floor(start * 1.05)));
		const mid = Math.sqrt(start * (end + 1));
		const weight = 1 / Math.pow(mid, ZIPF_S);
		raw.push([end - start + 1, weight]);
		harmonic += (end - start + 1) * weight;
		start = end + 1;
	}
	for (const [count, weight] of raw) bins.push({ count, hours: (WATCH_HOURS * weight) / harmonic });
}

const gbPerHour = (mbps: number): number => (3_600 * mbps) / 8 / 1_000;
const videoHours = VIDEO_MIN / 60;

heading(
	`অংশ ক — জনপ্রিয়তা: ${big(VIDEOS)} video (গড়ে ${VIDEO_MIN} মিনিট), মাসে ${big(WATCH_HOURS)} ঘণ্টা দেখা, Zipf (s = ${ZIPF_S})`
);
let seen = 0;
let acc = 0;
const targets = [0.001, 0.01, 0.1];
console.log(
	row([
		['সবচেয়ে জনপ্রিয়', 30],
		['video', 14],
		['দেখার ভাগ', 12],
		['edge এ জায়গা (সব resolution)', 28]
	])
);
for (const b of bins) {
	seen += b.count;
	acc += b.count * b.hours;
	const t = targets[0];
	if (t !== undefined && seen >= t * VIDEOS) {
		targets.shift();
		console.log(
			row([
				[`${t * 100}%`, 30],
				[big(seen), 14],
				[pct(acc, WATCH_HOURS, 1), 12],
				[bytes(seen * videoHours * gbPerHour(LADDER_MBPS) * 1e9), 28]
			])
		);
	}
}
let idle = 0;
let underSix = 0;
for (const b of bins) {
	idle += b.count * Math.exp(-b.hours / videoHours);
	if (b.hours < (H264_PER_HOUR * videoHours) / (gbPerHour(AVG_MBPS) * CDN_PER_GB))
		underSix += b.count;
}
console.log(`\nমাসে একবারও দেখা হয় না এমন video (আনুমানিক): ${pct(idle, VIDEOS, 1)}`);
console.log(
	`যাদের মাসের দেখার egress খরচ তাদের transcode এর খরচের চেয়ে কম: ${pct(underSix, VIDEOS, 1)}`
);

heading(
	`অংশ খ — কোন video কে AV1 এ আবার encode করব: ${AV1_SAVING * 100}% কম bit, encode ${AV1_COST_X} গুণ দামি`
);
const extraEncode = H264_PER_HOUR * (AV1_COST_X - 1) * videoHours;
const savingPerWatchHour = gbPerHour(AVG_MBPS) * CDN_PER_GB * AV1_SAVING;
const breakEven = extraEncode / savingPerWatchHour;
console.log(
	`একটা ${VIDEO_MIN} মিনিটের video এর বাড়তি encode: $${extraEncode.toFixed(3)}; প্রতি ঘণ্টা দেখায় বাঁচে $${savingPerWatchHour.toFixed(5)}`
);
console.log(`লাভ শুরু: মাসে ~${n(breakEven)} ঘণ্টা দেখা হলে (এক মাসে শোধ ধরে)\n`);
console.log(
	row([
		['নীতি', 34],
		['video', 14],
		['বাড়তি encode/মাস', 18],
		['egress বাঁচল/মাস', 18],
		['নিট', 14]
	])
);
const baseEgress = WATCH_HOURS * gbPerHour(AVG_MBPS) * CDN_PER_GB;
for (const [name, threshold] of [
	['কোনোটাই না', Number.POSITIVE_INFINITY],
	['সব video', 0],
	[`মাসে ${n(breakEven)} ঘণ্টার বেশি`, breakEven],
	[`মাসে ${n(breakEven * 10)} ঘণ্টার বেশি`, breakEven * 10]
] as const) {
	let count = 0;
	let hours = 0;
	for (const b of bins)
		if (b.hours >= threshold) {
			count += b.count;
			hours += b.count * b.hours;
		}
	const cost = count * extraEncode;
	const saved = hours * savingPerWatchHour;
	console.log(
		row([
			[name, 34],
			[big(count), 14],
			[`$${n(cost)}`, 18],
			[`$${n(saved)}`, 18],
			[`$${n(saved - cost)}`, 14]
		])
	);
}
console.log(
	`\nমোট egress মাসে $${n(baseEgress)}। নতুন video এর এক মাসের encode ধরা হয়েছে, পুরনো catalog এর একবারের খরচ না।`
);
