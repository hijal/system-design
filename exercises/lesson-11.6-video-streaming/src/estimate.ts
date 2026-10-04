import { big, bytes, env, heading, n, pct, row } from './util';

const DAU = env('DAU', 200_000_000);
const WATCH_MIN = env('WATCH_MIN', 60);
const AVG_MBPS = env('AVG_MBPS', 3);
const PEAK = env('PEAK', 2.5);
const UPLOAD_H_PER_MIN = env('UPLOAD_H_PER_MIN', 300);
const LADDER_MBPS = env('LADDER_MBPS', 10.4);
const SOURCE_MBPS = env('SOURCE_MBPS', 20);
const CPU_H_PER_H = env('CPU_H_PER_H', 4);
const CPU_HOUR = env('CPU_HOUR', 0.02);
const CDN_PER_GB = env('CDN_PER_GB', 0.01);
const STORAGE_PER_GB = env('STORAGE_PER_GB', 0.01);

const DAY = 86_400;
const bytesPerDay = DAU * WATCH_MIN * 60 * ((AVG_MBPS * 1e6) / 8);
const uploadHoursPerDay = UPLOAD_H_PER_MIN * 60 * 24;
const storedPerDay = uploadHoursPerDay * 3_600 * (((LADDER_MBPS + SOURCE_MBPS) * 1e6) / 8);
const cpuHoursPerDay = uploadHoursPerDay * CPU_H_PER_H;

heading(`অংশ ক — দেখা: ${big(DAU)} DAU, দিনে গড়ে ${WATCH_MIN} মিনিট, গড় ${AVG_MBPS} Mbps`);
const line = (label: string, value: string, note = ''): void =>
	console.log(
		row([
			[label, 46],
			[value, 18]
		]) + (note === '' ? '' : `   ${note}`)
	);
line('দিনে বের হওয়া data (egress)', bytes(bytesPerDay));
line('গড় bandwidth', `${n((bytesPerDay * 8) / DAY / 1e12)} Tbps`);
line(
	`peak bandwidth (${PEAK}×)`,
	`${n(((bytesPerDay * 8) / DAY / 1e12) * PEAK)} Tbps`,
	'কোনো একটা data center এর বাইরে'
);
line('একসাথে দেখছে (peak)', big(((DAU * WATCH_MIN * 60) / DAY) * PEAK));

heading(`অংশ খ — upload: প্রতি মিনিটে ${UPLOAD_H_PER_MIN} ঘণ্টার video`);
line('দিনে upload', `${n(uploadHoursPerDay)} ঘণ্টা`);
line(
	`জমা (মূল ${SOURCE_MBPS} + সব resolution ${LADDER_MBPS} Mbps)`,
	`${bytes(storedPerDay)}/দিন`,
	`বছরে ${bytes(storedPerDay * 365)}`
);
line(
	`transcoding (ঘণ্টায় ${CPU_H_PER_H} CPU-ঘণ্টা)`,
	`${n(cpuHoursPerDay / 24)} core`,
	'সারাক্ষণ চালু'
);

heading('অংশ গ — মাসিক খরচ (আনুমানিক দাম)');
const egress = (bytesPerDay / 1e9) * CDN_PER_GB * 30;
const storageMonth = ((storedPerDay * 365) / 1e9) * STORAGE_PER_GB;
const compute = cpuHoursPerDay * CPU_HOUR * 30;
const total = egress + storageMonth + compute;
console.log(
	row([
		['', 46],
		['মাসে', 18],
		['ভাগ', 10]
	])
);
for (const [label, value] of [
	[`CDN egress ($${CDN_PER_GB}/GB)`, egress],
	[`storage, এক বছরের জমা ($${STORAGE_PER_GB}/GB-মাস)`, storageMonth],
	[`transcoding ($${CPU_HOUR}/CPU-ঘণ্টা)`, compute]
] as const)
	console.log(
		row([
			[label, 46],
			[`$${n(value)}`, 18],
			[pct(value, total, 1), 10]
		])
	);
console.log(
	`\nএকটা ঘণ্টা দেখার খরচ: $${(((3_600 * ((AVG_MBPS * 1e6) / 8)) / 1e9) * CDN_PER_GB).toFixed(4)} egress — প্রতিটা দর্শক প্রতিবার।`
);
console.log(
	`একটা ঘণ্টা transcode এর খরচ: $${(CPU_H_PER_H * CPU_HOUR).toFixed(2)} — একবার। ${n((CPU_H_PER_H * CPU_HOUR) / (((3_600 * ((AVG_MBPS * 1e6) / 8)) / 1e9) * CDN_PER_GB))} ঘণ্টা দেখা = এক ঘণ্টা transcode।`
);
