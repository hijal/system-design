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
	`Part A - popularity: ${big(VIDEOS)} videos (${VIDEO_MIN} minutes on average), ${big(WATCH_HOURS)} hours watched a month, Zipf (s = ${ZIPF_S})`
);
let seen = 0;
let acc = 0;
const targets = [0.001, 0.01, 0.1];
console.log(
	row([
		['most popular', 30],
		['video', 14],
		['share of watching', 19],
		['space at the edge (all resolutions)', 37]
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
				[pct(acc, WATCH_HOURS, 1), 19],
				[bytes(seen * videoHours * gbPerHour(LADDER_MBPS) * 1e9), 37]
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
console.log(`\nvideos not watched even once a month (approx.): ${pct(idle, VIDEOS, 1)}`);
console.log(
	`videos whose monthly watching egress costs less than their transcode: ${pct(underSix, VIDEOS, 1)}`
);

heading(
	`Part B - which videos to re-encode in AV1: ${AV1_SAVING * 100}% fewer bits, encoding ${AV1_COST_X}× as expensive`
);
const extraEncode = H264_PER_HOUR * (AV1_COST_X - 1) * videoHours;
const savingPerWatchHour = gbPerHour(AVG_MBPS) * CDN_PER_GB * AV1_SAVING;
const breakEven = extraEncode / savingPerWatchHour;
console.log(
	`extra encode for a ${VIDEO_MIN}-minute video: $${extraEncode.toFixed(3)}; saved per hour watched $${savingPerWatchHour.toFixed(5)}`
);
console.log(
	`break-even: at ~${n(breakEven)} hours watched a month (assuming it pays back within a month)\n`
);
console.log(
	row([
		['policy', 34],
		['video', 14],
		['extra encode/month', 20],
		['egress saved/month', 20],
		['net', 14]
	])
);
const baseEgress = WATCH_HOURS * gbPerHour(AVG_MBPS) * CDN_PER_GB;
for (const [name, threshold] of [
	['none', Number.POSITIVE_INFINITY],
	['all videos', 0],
	[`over ${n(breakEven)} hours a month`, breakEven],
	[`over ${n(breakEven * 10)} hours a month`, breakEven * 10]
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
			[`$${n(cost)}`, 20],
			[`$${n(saved)}`, 20],
			[`$${n(saved - cost)}`, 14]
		])
	);
}
console.log(
	`\ntotal egress $${n(baseEgress)} a month. One month of encoding new videos is counted, not the one-off cost of the old catalogue.`
);
