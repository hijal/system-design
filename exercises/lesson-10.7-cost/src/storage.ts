import { PRICE as P } from './prices';
import { env, heading, n, row, tb, usd } from './util';

const MONTHS = env('MONTHS', 24);
const START_GB = env('START_GB', 18_000);
const START_NONCURRENT_GB = env('START_NONCURRENT_GB', 14_000);
const UPLOAD_GB = env('UPLOAD_GB', 1_200);
const GROWTH = env('GROWTH', 0.03);
const SMALL_SHARE = env('SMALL_SHARE', 0.6);
const SMALL_KB = env('SMALL_KB', 40);
const LARGE_MB = env('LARGE_MB', 2);
const EXPORT_GB = env('EXPORT_GB', 3_000);
const EXPORT_MONTH = env('EXPORT_MONTH', 18);

const MIN_BILLABLE_KB = 128;
const avgObjectMb = SMALL_SHARE * (SMALL_KB / 1_000) + (1 - SMALL_SHARE) * LARGE_MB;
const objectsPerGb = 1_000 / avgObjectMb;
const smallByteShare = (SMALL_SHARE * (SMALL_KB / 1_000)) / avgObjectMb;
const smallIaBillFactor = Math.max(1, MIN_BILLABLE_KB / SMALL_KB);

type Cohort = { gb: number; age: number };
type Policy = {
	name: string;
	expireNoncurrent: boolean;
	ia: 'none' | 'all' | 'large';
	glacierAfter: number | null;
	exportEvent: boolean;
};

const POLICIES: Policy[] = [
	{
		name: 'all Standard, old versions forever',
		expireNoncurrent: false,
		ia: 'none',
		glacierAfter: null,
		exportEvent: false
	},
	{
		name: '+ old versions deleted at 30 days',
		expireNoncurrent: true,
		ia: 'none',
		glacierAfter: null,
		exportEvent: false
	},
	{
		name: '+ everything to IA at 30 days (small ones too)',
		expireNoncurrent: true,
		ia: 'all',
		glacierAfter: null,
		exportEvent: false
	},
	{
		name: '+ only ≥128 KB to IA, Glacier IR at 180 days',
		expireNoncurrent: true,
		ia: 'large',
		glacierAfter: 6,
		exportEvent: false
	},
	{
		name: `the same, exporting ${tb(EXPORT_GB)} of old files in month ${EXPORT_MONTH}`,
		expireNoncurrent: true,
		ia: 'large',
		glacierAfter: 6,
		exportEvent: true
	}
];

const readFactor = (age: number): number => (age === 0 ? 1.5 : age <= 5 ? 0.1 : 0.01);

type Month = { storage: number; transitions: number; retrieval: number; total: number };

function run(policy: Policy): { months: Month[]; finalGb: number; noncurrentGb: number } {
	const cohorts: Cohort[] = [{ gb: START_GB, age: 12 }];
	let noncurrent = START_NONCURRENT_GB;
	const months: Month[] = [];
	for (let m = 0; m < MONTHS; m++) {
		const upload = UPLOAD_GB * (1 + GROWTH) ** m;
		cohorts.push({ gb: upload, age: 0 });
		noncurrent = policy.expireNoncurrent ? upload * 0.4 : noncurrent + upload * 0.4;
		let storage = noncurrent * P.s3StandardGbMonth;
		let transitions = 0;
		let retrieval = 0;
		for (const c of cohorts) {
			const small = c.gb * smallByteShare;
			const large = c.gb - small;
			const objects = c.gb * objectsPerGb;
			const smallObjects = objects * SMALL_SHARE;
			const largeObjects = objects - smallObjects;
			const glacier = policy.glacierAfter !== null && c.age >= policy.glacierAfter;
			const inIa = c.age >= 1;
			const reads = c.gb * readFactor(c.age);
			if (policy.ia === 'none' || !inIa) {
				storage += c.gb * P.s3StandardGbMonth;
			} else if (policy.ia === 'all') {
				storage += (small * smallIaBillFactor + large) * P.s3IaGbMonth;
				retrieval += reads * P.s3IaRetrievalGb;
				if (c.age === 1) transitions += (objects / 1_000) * P.s3TransitionIaPer1k;
			} else {
				storage += small * P.s3StandardGbMonth;
				storage += large * (glacier ? P.s3GlacierIrGbMonth : P.s3IaGbMonth);
				retrieval +=
					(reads - reads * smallByteShare) *
					(glacier ? P.s3GlacierIrRetrievalGb : P.s3IaRetrievalGb);
				if (c.age === 1) transitions += (largeObjects / 1_000) * P.s3TransitionIaPer1k;
				if (policy.glacierAfter !== null && c.age === policy.glacierAfter)
					transitions += (largeObjects / 1_000) * P.s3TransitionGirPer1k;
			}
		}
		if (policy.exportEvent && m === EXPORT_MONTH - 1)
			retrieval += EXPORT_GB * (1 - smallByteShare) * P.s3GlacierIrRetrievalGb;
		months.push({ storage, transitions, retrieval, total: storage + transitions + retrieval });
		for (const c of cohorts) c.age++;
	}
	return { months, finalGb: cohorts.reduce((s, c) => s + c.gb, 0), noncurrentGb: noncurrent };
}

heading(
	`Part A - ${MONTHS} months of attachments: ${tb(START_GB)} + ${tb(START_NONCURRENT_GB)} of old versions at the start, ${tb(UPLOAD_GB)} new a month (+${Math.round(GROWTH * 100)}%/month)`
);
console.log(
	`objects: ${Math.round(SMALL_SHARE * 100)}% small (~${SMALL_KB} KB, thumbnails/avatars), the rest ~${LARGE_MB} MB; the small ones are ${Math.round(SMALL_SHARE * 100)}% by count, ${(smallByteShare * 100).toFixed(1)}% by bytes\n`
);
console.log(
	row([
		['policy', 56],
		['month 1', 10],
		[`month ${MONTHS}`, 10],
		[`total, ${MONTHS} months`, 18],
		['transition fee', 15],
		['retrieval fee', 15]
	])
);
for (const policy of POLICIES) {
	const r = run(policy);
	const sum = (pick: (m: Month) => number): number => r.months.reduce((s, m) => s + pick(m), 0);
	console.log(
		row([
			[policy.name, 56],
			[usd(r.months[0]?.total ?? 0), 10],
			[usd(r.months[MONTHS - 1]?.total ?? 0), 10],
			[usd(sum((m) => m.total)), 18],
			[usd(sum((m) => m.transitions)), 15],
			[usd(sum((m) => m.retrieval)), 15]
		])
	);
}
const plain = run(
	POLICIES[0] ?? {
		name: '',
		expireNoncurrent: false,
		ia: 'none',
		glacierAfter: null,
		exportEvent: false
	}
);
console.log(
	`\n(live data in month ${MONTHS}: ${tb(plain.finalGb)}; keeping versions forever, old versions ${tb(plain.noncurrentGb)})`
);

heading(`Part B - the small-object trap: 1 TB of only ${SMALL_KB} KB objects, one year`);
const smallObjects = 1_000_000_000 / SMALL_KB;
const standardYear = 1_000 * P.s3StandardGbMonth * 12;
const iaYear =
	1_000 * smallIaBillFactor * P.s3IaGbMonth * 12 + (smallObjects / 1_000) * P.s3TransitionIaPer1k;
const girYear =
	1_000 * smallIaBillFactor * P.s3GlacierIrGbMonth * 12 +
	(smallObjects / 1_000) * P.s3TransitionGirPer1k;
console.log(
	row([
		['class', 30],
		['object', 14],
		['billed size', 14],
		['in one year', 12]
	])
);
console.log(
	row([
		['Standard', 30],
		[n(smallObjects), 14],
		[tb(1_000), 14],
		[usd(standardYear), 12]
	])
);
console.log(
	row([
		['IA (with transition)', 30],
		[n(smallObjects), 14],
		[tb(1_000 * smallIaBillFactor), 14],
		[usd(iaYear), 12]
	])
);
console.log(
	row([
		['Glacier IR (with transition)', 30],
		[n(smallObjects), 14],
		[tb(1_000 * smallIaBillFactor), 14],
		[usd(girYear), 12]
	])
);
console.log(
	`\n(IA and Glacier IR bill every object as at least ${MIN_BILLABLE_KB} KB, and every transition is a request)`
);

heading('Part C - logs: where does the money go - ingesting, or keeping?');
const SCENARIOS: [string, number][] = [
	['one line per request (10.4)', 2.8],
	['+ debug in three services', 47.8],
	['10% sample of successful requests', 1.5]
];
const RETENTION: [string, number, number][] = [
	['14 days', 14, 0],
	['90 days', 90, 0],
	['365 days', 365, 0],
	['14 days + 1 year in S3', 14, 365]
];
console.log(
	row([
		['per day', 36],
		['GB/day', 8],
		['ingest / month', 16],
		...RETENTION.map(([name]): [string, number] => [`keep: ${name}`, 22])
	])
);
for (const [name, gbDay] of SCENARIOS) {
	const ingest = gbDay * 30 * P.logIngestGb;
	const cells = RETENTION.map(([, hot, archive]): [string, number] => {
		const hotCost = gbDay * hot * P.logStoreGbMonth;
		const archiveCost = (gbDay / 8) * archive * P.s3IaGbMonth;
		return [usd(hotCost + archiveCost), 22];
	});
	console.log(row([[name, 36], [gbDay.toFixed(1), 8], [usd(ingest), 16], ...cells]));
}
console.log(
	'\n("keep" = the monthly storage cost, on top of ingest; the S3 archive assumed compressed 8×)'
);

heading('Part D - the activity table: all in Postgres, or in S3 after 90 days (Parquet)');
const ACTIVITY_START = env('ACTIVITY_GB', 1_100);
const ACTIVITY_MONTHLY = env('ACTIVITY_MONTHLY_GB', 60);
const COPIES = 4;
const COMPRESSION = 6;
console.log(
	row([
		['design', 46],
		['month 1', 10],
		[`month ${MONTHS}`, 10],
		[`total, ${MONTHS} months`, 18],
		[`in DB, month ${MONTHS}`, 17]
	])
);
for (const offload of [false, true]) {
	let first = 0;
	let last = 0;
	let sum = 0;
	let dbGb = 0;
	for (let m = 0; m < MONTHS; m++) {
		const totalGb = ACTIVITY_START + ACTIVITY_MONTHLY * (m + 1);
		dbGb = offload ? ACTIVITY_MONTHLY * 3 : totalGb;
		const archived = offload ? (totalGb - dbGb) / COMPRESSION : 0;
		const cost =
			dbGb * COPIES * P.dbStorageGbMonth + dbGb * P.backupGbMonth + archived * P.s3IaGbMonth;
		if (m === 0) first = cost;
		last = cost;
		sum += cost;
	}
	console.log(
		row([
			[
				offload
					? '90 days in Postgres, the rest in S3 Parquet'
					: 'all in Postgres (4 copies + backup)',
				46
			],
			[usd(first), 10],
			[usd(last), 10],
			[usd(sum), 18],
			[tb(dbGb), 17]
		])
	);
}
