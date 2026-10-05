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

heading(
	`Part A — watching: ${big(DAU)} DAU, ${WATCH_MIN} minutes a day on average, ${AVG_MBPS} Mbps on average`
);
const line = (label: string, value: string, note = ''): void =>
	console.log(
		row([
			[label, 52],
			[value, 18]
		]) + (note === '' ? '' : `   ${note}`)
	);
line('data out per day (egress)', bytes(bytesPerDay));
line('average bandwidth', `${n((bytesPerDay * 8) / DAY / 1e12)} Tbps`);
line(
	`peak bandwidth (${PEAK}×)`,
	`${n(((bytesPerDay * 8) / DAY / 1e12) * PEAK)} Tbps`,
	'beyond any single data center'
);
line('watching at once (peak)', big(((DAU * WATCH_MIN * 60) / DAY) * PEAK));

heading(`Part B — uploads: ${UPLOAD_H_PER_MIN} hours of video every minute`);
line('uploaded per day', `${n(uploadHoursPerDay)} hours`);
line(
	`stored (original ${SOURCE_MBPS} + all resolutions ${LADDER_MBPS} Mbps)`,
	`${bytes(storedPerDay)}/day`,
	`${bytes(storedPerDay * 365)} a year`
);
line(
	`transcoding (${CPU_H_PER_H} CPU-hours per hour)`,
	`${n(cpuHoursPerDay / 24)} cores`,
	'running all the time'
);

heading('Part C — monthly cost (approximate prices)');
const egress = (bytesPerDay / 1e9) * CDN_PER_GB * 30;
const storageMonth = ((storedPerDay * 365) / 1e9) * STORAGE_PER_GB;
const compute = cpuHoursPerDay * CPU_HOUR * 30;
const total = egress + storageMonth + compute;
console.log(
	row([
		['', 52],
		['monthly', 18],
		['share', 10]
	])
);
for (const [label, value] of [
	[`CDN egress ($${CDN_PER_GB}/GB)`, egress],
	[`storage, one year's accumulation ($${STORAGE_PER_GB}/GB-month)`, storageMonth],
	[`transcoding ($${CPU_HOUR}/CPU-hour)`, compute]
] as const)
	console.log(
		row([
			[label, 52],
			[`$${n(value)}`, 18],
			[pct(value, total, 1), 10]
		])
	);
console.log(
	`\nthe cost of watching one hour: $${(((3_600 * ((AVG_MBPS * 1e6) / 8)) / 1e9) * CDN_PER_GB).toFixed(4)} egress — for every viewer, every time.`
);
console.log(
	`the cost of transcoding one hour: $${(CPU_H_PER_H * CPU_HOUR).toFixed(2)} — once. ${n((CPU_H_PER_H * CPU_HOUR) / (((3_600 * ((AVG_MBPS * 1e6) / 8)) / 1e9) * CDN_PER_GB))} hours watched = one hour transcoded.`
);
