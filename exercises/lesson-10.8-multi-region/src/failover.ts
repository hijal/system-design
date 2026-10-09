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
		name: 'one region, wait for it to return',
		steps: [['region returns', OUTAGE_MINUTES]],
		rpoSeconds: 0,
		extraMonthly: 0,
		note: 'if the data survives'
	},
	{
		name: 'backup & restore (daily snapshot to another region)',
		steps: [
			['detect', DETECT],
			['decide', DECIDE],
			['infra via IaC', 30],
			[`DB restore (${DB_GB} GB)`, restoreMinutes],
			['verify', 15],
			['DNS', 5]
		],
		rpoSeconds: (BACKUP_HOURS / 2) * 3_600,
		extraMonthly: DB_GB * 3 * PRICE.snapshotGb + 50 * 30 * PRICE.interRegionGb + 18_000 * 0.004,
		note: 'snapshots + attachments in Glacier'
	},
	{
		name: 'pilot light (DB replica running, app off)',
		steps: [
			['detect', DETECT],
			['decide', DECIDE],
			['start app from zero', 15],
			['replica promote', 2],
			['DNS', 5]
		],
		rpoSeconds: LAG_SECONDS,
		extraMonthly: replicaDb + attachmentReplica + walTransfer,
		note: 'async replica + S3 replication'
	},
	{
		name: 'warm standby (small app running)',
		steps: [
			['detect', DETECT],
			['decide', 10],
			['scale out', 5],
			['replica promote', 2],
			['DNS', 5]
		],
		rpoSeconds: LAG_SECONDS,
		extraMonthly: replicaDb + attachmentReplica + walTransfer + 2 * PRICE.app * H + PRICE.cache * H,
		note: '2 apps + 1 cache always'
	},
	{
		name: 'active-active (running in every region)',
		steps: [
			['detect', 2],
			['automatic promote (with witness)', 1],
			['global LB / anycast', 1]
		],
		rpoSeconds: LAG_SECONDS,
		extraMonthly:
			3 * (replicaDb + 5 * PRICE.app * H * PRICE.keep + PRICE.cache * H) +
			attachmentReplica +
			3 * walTransfer +
			1_500 * PRICE.interRegionGb,
		note: '3 extra regions, full size'
	}
];

heading(
	`Part A - the Singapore region down for ${duration(OUTAGE_MINUTES)}: ${RPS} req/s, ${Math.round(WRITE_SHARE * 100)}% of them writes`
);
console.log(
	row([
		['strategy', 54],
		['RTO', 8],
		['RPO', 10],
		['lost writes', 13],
		['failed requests', 17],
		['extra / month', 15],
		['', 2],
		['where the RTO goes', 60]
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
			[s.name, 54],
			[duration(rto), 8],
			[rpo === 0 ? '0' : duration(rpo / 60), 10],
			[n(lost), 13],
			[n(failed), 17],
			[usd(s.extraMonthly), 15],
			['', 2],
			[
				regionBackFirst && s.steps.length > 1
					? `  the region came back before failover finished (plan ${duration(planned)})`
					: `  ${s.steps.map(([name, m]) => `${name} ${duration(m)}`).join(' → ')}`,
				60
			]
		])
	);
}
console.log(
	`\n(RPO = how far the data had reached the other region; "lost writes" = RPO × ${writesPerSecond} writes/s. Extra cost on top of 10.7's $8,276)`
);

heading('Part B - after changing DNS: what % of traffic still goes to the dead region');
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
		['routing', 44],
		...MOMENTS.map((t): [string, number] => [`+${duration(t / 60)}`, 10]),
		['failed in hour 1', 20]
	])
);
for (const [name, ttl] of [
	['DNS, TTL 60 s', 60],
	['DNS, TTL 300 s', 300],
	['DNS, TTL 3,600 s', 3_600],
	["anycast / global LB (DNS doesn't change)", 0]
] as const) {
	let failedHour = 0;
	for (let t = 0; t < 3_600; t++) failedHour += remaining(ttl, t) * RPS;
	console.log(
		row([
			[name, 44],
			...MOMENTS.map((t): [string, number] => [pct(remaining(ttl, t), 1, 0), 10]),
			[n(failedHour), 20]
		])
	);
}
console.log(
	`\n(assumed: ${Math.round(HONOR * 100)}% of clients honour the TTL; ${Math.round(CLAMP * 100)}% have a resolver that treats the TTL as at least ${CLAMP_SECONDS / 60} minutes; ${Math.round(STICKY * 100)}% hold on to the old IP for up to an hour - open connections, the app's own cache)`
);

heading(
	`Part C - Singapore is not dead, only cut off from the rest, for ${PARTITION_MINUTES} minutes (${Math.round(SG_WRITE_SHARE * 100)}% of writes are from Singapore users)`
);
type Policy = { name: string; failoverAt: number | null; fence: boolean };
const POLICIES: Policy[] = [
	{ name: 'no automatic failover', failoverAt: null, fence: false },
	{ name: 'Mumbai promotes itself after 2 minutes', failoverAt: 2, fence: false },
	{ name: 'with a witness (majority + lease, fencing)', failoverAt: 2, fence: true }
];
console.log(
	row([
		['policy', 46],
		['failed writes', 15],
		['divergent writes', 22],
		['who could write', 40]
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
				who: "Singapore only; everyone else's writes fail"
			};
		if (!p.fence)
			return {
				failed: rest * p.failoverAt,
				divergent: sg * (PARTITION_MINUTES - p.failoverAt),
				who: 'both sides - two primaries (split brain)'
			};
		const leaseSeconds = 30;
		return {
			failed: rest * p.failoverAt + sg * (PARTITION_MINUTES - leaseSeconds / 60),
			divergent: 0,
			who: 'the Mumbai side; Singapore stops itself after 30 s'
		};
	};
	const { failed, divergent, who } = outcome();
	console.log(
		row([
			[p.name, 46],
			[n(failed), 15],
			[n(divergent), 22],
			[`  ${who}`, 40]
		])
	);
}
