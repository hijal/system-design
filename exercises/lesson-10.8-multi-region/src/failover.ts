import { env, heading, n, pct, row, usd, duration } from './util';

const RPS = env('RPS', 300);
const WRITE_SHARE = env('WRITE_SHARE', 0.1);
const OUTAGE_MINUTES = env('OUTAGE_MINUTES', 240);
const DETECT = env('DETECT_MINUTES', 5);
const DECIDE = env('DECIDE_MINUTES', 15);
const LAG_SECONDS = env('LAG_SECONDS', 5);
const BACKUP_HOURS = env('BACKUP_HOURS', 24);
const DB_GB = env('DB_GB', 900);
const RESTORE_MB_S = env('RESTORE_MB_S', 250);
const PARTITION_MINUTES = env('PARTITION_MINUTES', 10);
const SG_WRITE_SHARE = env('SG_WRITE_SHARE', 0.15);

const H = 730;
const PRICE = {
	app: 0.192,
	db: 1.0,
	cache: 0.2,
	dbGb: 0.115,
	snapshotGb: 0.095,
	s3IaGb: 0.0125,
	interRegionGb: 0.02,
	keep: 0.65
};
const writesPerSecond = RPS * WRITE_SHARE;

type Strategy = {
	name: string;
	steps: [string, number][];
	rpoSeconds: number;
	extraMonthly: number;
	note: string;
};

const restoreMinutes = (DB_GB * 1_000) / RESTORE_MB_S / 60;
const replicaDb = PRICE.db * H * PRICE.keep + DB_GB * PRICE.dbGb;
const attachmentReplica = 18_000 * PRICE.s3IaGb + 1_200 * PRICE.interRegionGb;
const walTransfer = 300 * PRICE.interRegionGb;

const STRATEGIES: Strategy[] = [
	{
		name: 'এক region, ফেরার অপেক্ষা',
		steps: [['region ফেরা', OUTAGE_MINUTES]],
		rpoSeconds: 0,
		extraMonthly: 0,
		note: 'data টিকে থাকলে'
	},
	{
		name: 'backup & restore (রোজ snapshot অন্য region এ)',
		steps: [
			['ধরা', DETECT],
			['সিদ্ধান্ত', DECIDE],
			['IaC দিয়ে infra', 30],
			[`DB restore (${DB_GB} GB)`, restoreMinutes],
			['যাচাই', 15],
			['DNS', 5]
		],
		rpoSeconds: (BACKUP_HOURS / 2) * 3_600,
		extraMonthly: DB_GB * 3 * PRICE.snapshotGb + 50 * 30 * PRICE.interRegionGb + 18_000 * 0.004,
		note: 'snapshot + Glacier এ attachment'
	},
	{
		name: 'pilot light (DB replica চালু, app বন্ধ)',
		steps: [
			['ধরা', DETECT],
			['সিদ্ধান্ত', DECIDE],
			['app শূন্য থেকে চালু', 15],
			['replica promote', 2],
			['DNS', 5]
		],
		rpoSeconds: LAG_SECONDS,
		extraMonthly: replicaDb + attachmentReplica + walTransfer,
		note: 'async replica + S3 replication'
	},
	{
		name: 'warm standby (ছোট app চালু)',
		steps: [
			['ধরা', DETECT],
			['সিদ্ধান্ত', 10],
			['scale out', 5],
			['replica promote', 2],
			['DNS', 5]
		],
		rpoSeconds: LAG_SECONDS,
		extraMonthly: replicaDb + attachmentReplica + walTransfer + 2 * PRICE.app * H + PRICE.cache * H,
		note: '২টা app + ১টা cache সবসময়'
	},
	{
		name: 'active-active (সব region এ চলছে)',
		steps: [
			['ধরা', 2],
			['স্বয়ংক্রিয় promote (witness সহ)', 1],
			['global LB / anycast', 1]
		],
		rpoSeconds: LAG_SECONDS,
		extraMonthly:
			3 * (replicaDb + 5 * PRICE.app * H * PRICE.keep + PRICE.cache * H) +
			attachmentReplica +
			3 * walTransfer +
			1_500 * PRICE.interRegionGb,
		note: '৩টা বাড়তি region, পূর্ণ মাপে'
	}
];

heading(
	`অংশ ক — সিঙ্গাপুর region ${duration(OUTAGE_MINUTES)} বন্ধ: ${RPS} req/s, তার ${Math.round(WRITE_SHARE * 100)}% লেখা`
);
console.log(
	row([
		['কৌশল', 46],
		['RTO', 8],
		['RPO', 10],
		['হারানো লেখা', 13],
		['ব্যর্থ request', 15],
		['বাড়তি / মাস', 13],
		['', 2],
		['RTO কোথায় যায়', 60]
	])
);
for (const s of STRATEGIES) {
	const planned = s.steps.reduce((sum, [, m]) => sum + m, 0);
	const regionBackFirst = planned >= OUTAGE_MINUTES;
	const rto = Math.min(OUTAGE_MINUTES, planned);
	const rpo = regionBackFirst ? 0 : s.rpoSeconds;
	const lost = rpo * writesPerSecond;
	const failed = rto * 60 * RPS;
	console.log(
		row([
			[s.name, 46],
			[duration(rto), 8],
			[rpo === 0 ? '০' : duration(rpo / 60), 10],
			[n(lost), 13],
			[n(failed), 15],
			[usd(s.extraMonthly), 13],
			['', 2],
			[
				regionBackFirst && s.steps.length > 1
					? `  failover শেষ হওয়ার আগেই region ফিরল (পরিকল্পনা ${duration(planned)})`
					: `  ${s.steps.map(([name, m]) => `${name} ${duration(m)}`).join(' → ')}`,
				60
			]
		])
	);
}
console.log(
	`\n(RPO = শেষ যেখান পর্যন্ত data অন্য region এ পৌঁছেছিল; "হারানো লেখা" = RPO × ${writesPerSecond} লেখা/s। বাড়তি খরচ 10.7 এর $8,276 এর উপরে)`
);

heading('অংশ খ — DNS বদলানোর পরে: কত % traffic এখনও মরা region এ যায়');
const HONOR = 0.7;
const CLAMP = 0.2;
const STICKY = 0.1;
const CLAMP_SECONDS = 300;
const STICKY_SECONDS = 3_600;
const remaining = (ttl: number, t: number): number => {
	if (ttl === 0) return t < 60 ? 1 - t / 60 : 0;
	const left = (span: number): number => Math.max(0, 1 - t / span);
	return (
		HONOR * left(ttl) + CLAMP * left(Math.max(ttl, CLAMP_SECONDS)) + STICKY * left(STICKY_SECONDS)
	);
};
const MOMENTS = [60, 300, 900, 1_800, 3_600];
console.log(
	row([
		['routing', 34],
		...MOMENTS.map((t): [string, number] => [`+${duration(t / 60)}`, 10]),
		['প্রথম ঘণ্টায় ব্যর্থ', 20]
	])
);
for (const [name, ttl] of [
	['DNS, TTL ৬০ s', 60],
	['DNS, TTL ৩০০ s', 300],
	['DNS, TTL ৩,৬০০ s', 3_600],
	['anycast / global LB (DNS বদলায় না)', 0]
] as const) {
	let failedHour = 0;
	for (let t = 0; t < 3_600; t++) failedHour += remaining(ttl, t) * RPS;
	console.log(
		row([
			[name, 34],
			...MOMENTS.map((t): [string, number] => [pct(remaining(ttl, t), 1, 0), 10]),
			[n(failedHour), 20]
		])
	);
}
console.log(
	`\n(ধরা: ${Math.round(HONOR * 100)}% client TTL মানে; ${Math.round(CLAMP * 100)}% এর resolver TTL কে অন্তত ${CLAMP_SECONDS / 60} মিনিট ধরে; ${Math.round(STICKY * 100)}% পুরনো IP ধরে থাকে এক ঘণ্টা পর্যন্ত — খোলা connection, app এর নিজের cache)`
);

heading(
	`অংশ গ — সিঙ্গাপুর মরেনি, শুধু বাকিদের থেকে বিচ্ছিন্ন, ${PARTITION_MINUTES} মিনিট (লেখার ${Math.round(SG_WRITE_SHARE * 100)}% সিঙ্গাপুরের user এর)`
);
type Policy = { name: string; failoverAt: number | null; fence: boolean };
const POLICIES: Policy[] = [
	{ name: 'স্বয়ংক্রিয় failover নেই', failoverAt: null, fence: false },
	{ name: 'মুম্বাই ২ মিনিটে নিজেই promote করে', failoverAt: 2, fence: false },
	{ name: 'witness সহ (majority + lease, fencing)', failoverAt: 2, fence: true }
];
console.log(
	row([
		['নীতি', 42],
		['ব্যর্থ লেখা', 13],
		['দুই দিকে আলাদা লেখা', 22],
		['কে লিখতে পারল', 40]
	])
);
for (const p of POLICIES) {
	const perMinute = writesPerSecond * 60;
	const sg = perMinute * SG_WRITE_SHARE;
	const rest = perMinute - sg;
	const outcome = (): { failed: number; divergent: number; who: string } => {
		if (p.failoverAt === null)
			return {
				failed: rest * PARTITION_MINUTES,
				divergent: 0,
				who: 'শুধু সিঙ্গাপুর; বাকি সবার লেখা ব্যর্থ'
			};
		if (!p.fence)
			return {
				failed: rest * p.failoverAt,
				divergent: sg * (PARTITION_MINUTES - p.failoverAt),
				who: 'দুই দিকেই — দুটো primary (split brain)'
			};
		const leaseSeconds = 30;
		return {
			failed: rest * p.failoverAt + sg * (PARTITION_MINUTES - leaseSeconds / 60),
			divergent: 0,
			who: 'মুম্বাই পক্ষ; সিঙ্গাপুর ৩০ s পরে নিজেকে থামায়'
		};
	};
	const { failed, divergent, who } = outcome();
	console.log(
		row([
			[p.name, 42],
			[n(failed), 13],
			[n(divergent), 22],
			[`  ${who}`, 40]
		])
	);
}
