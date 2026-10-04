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
		name: 'সব Standard, পুরনো version চিরকাল',
		expireNoncurrent: false,
		ia: 'none',
		glacierAfter: null,
		exportEvent: false
	},
	{
		name: '+ পুরনো version ৩০ দিনে মোছা',
		expireNoncurrent: true,
		ia: 'none',
		glacierAfter: null,
		exportEvent: false
	},
	{
		name: '+ ৩০ দিনে সব IA (ছোট সহ)',
		expireNoncurrent: true,
		ia: 'all',
		glacierAfter: null,
		exportEvent: false
	},
	{
		name: '+ শুধু ≥১২৮ KB IA, ১৮০ দিনে Glacier IR',
		expireNoncurrent: true,
		ia: 'large',
		glacierAfter: 6,
		exportEvent: false
	},
	{
		name: `একই, মাস ${EXPORT_MONTH} এ ${tb(EXPORT_GB)} পুরনো file export`,
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
	`অংশ ক — attachment এর ${MONTHS} মাস: শুরুতে ${tb(START_GB)} + ${tb(START_NONCURRENT_GB)} পুরনো version, মাসে ${tb(UPLOAD_GB)} নতুন (+${Math.round(GROWTH * 100)}%/মাস)`
);
console.log(
	`object: ${Math.round(SMALL_SHARE * 100)}% ছোট (~${SMALL_KB} KB, thumbnail/avatar), বাকি ~${LARGE_MB} MB; ছোটরা গুনতিতে ${Math.round(SMALL_SHARE * 100)}%, bytes এ ${(smallByteShare * 100).toFixed(1)}%\n`
);
console.log(
	row([
		['নীতি', 46],
		['মাস ১', 10],
		[`মাস ${MONTHS}`, 10],
		[`${MONTHS} মাসে মোট`, 14],
		['transition fee', 15],
		['retrieval fee', 15]
	])
);
for (const policy of POLICIES) {
	const r = run(policy);
	const sum = (pick: (m: Month) => number): number => r.months.reduce((s, m) => s + pick(m), 0);
	console.log(
		row([
			[policy.name, 46],
			[usd(r.months[0]?.total ?? 0), 10],
			[usd(r.months[MONTHS - 1]?.total ?? 0), 10],
			[usd(sum((m) => m.total)), 14],
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
	`\n(মাস ${MONTHS} এ চালু data ${tb(plain.finalGb)}; version চিরকাল রাখলে পুরনো version ${tb(plain.noncurrentGb)})`
);

heading(`অংশ খ — ছোট object এর ফাঁদ: ১ TB শুধু ${SMALL_KB} KB এর object, এক বছর`);
const smallObjects = 1_000_000_000 / SMALL_KB;
const standardYear = 1_000 * P.s3StandardGbMonth * 12;
const iaYear =
	1_000 * smallIaBillFactor * P.s3IaGbMonth * 12 + (smallObjects / 1_000) * P.s3TransitionIaPer1k;
const girYear =
	1_000 * smallIaBillFactor * P.s3GlacierIrGbMonth * 12 +
	(smallObjects / 1_000) * P.s3TransitionGirPer1k;
console.log(
	row([
		['class', 22],
		['object', 14],
		['বিলের আকার', 14],
		['এক বছরে', 12]
	])
);
console.log(
	row([
		['Standard', 22],
		[n(smallObjects), 14],
		[tb(1_000), 14],
		[usd(standardYear), 12]
	])
);
console.log(
	row([
		['IA (transition সহ)', 22],
		[n(smallObjects), 14],
		[tb(1_000 * smallIaBillFactor), 14],
		[usd(iaYear), 12]
	])
);
console.log(
	row([
		['Glacier IR (transition সহ)', 22],
		[n(smallObjects), 14],
		[tb(1_000 * smallIaBillFactor), 14],
		[usd(girYear), 12]
	])
);
console.log(
	`\n(IA আর Glacier IR প্রতিটা object কে অন্তত ${MIN_BILLABLE_KB} KB ধরে বিল করে, আর প্রতিটা transition একটা request)`
);

heading('অংশ গ — log: কোথায় টাকা যায় — ঢোকানোয়, না রাখায়?');
const SCENARIOS: [string, number][] = [
	['প্রতি request এ একটা লাইন (10.4)', 2.8],
	['+ তিনটা service এ debug', 47.8],
	['সফল request এর ১০% sample', 1.5]
];
const RETENTION: [string, number, number][] = [
	['১৪ দিন', 14, 0],
	['৯০ দিন', 90, 0],
	['৩৬৫ দিন', 365, 0],
	['১৪ দিন + ১ বছর S3 এ', 14, 365]
];
console.log(
	row([
		['প্রতিদিন', 34],
		['GB/দিন', 8],
		['ঢোকানো / মাস', 14],
		...RETENTION.map(([name]): [string, number] => [`রাখা: ${name}`, 22])
	])
);
for (const [name, gbDay] of SCENARIOS) {
	const ingest = gbDay * 30 * P.logIngestGb;
	const cells = RETENTION.map(([, hot, archive]): [string, number] => {
		const hotCost = gbDay * hot * P.logStoreGbMonth;
		const archiveCost = (gbDay / 8) * archive * P.s3IaGbMonth;
		return [usd(hotCost + archiveCost), 22];
	});
	console.log(row([[name, 34], [gbDay.toFixed(1), 8], [usd(ingest), 14], ...cells]));
}
console.log('\n("রাখা" = মাসিক জমার খরচ, ঢোকানোর বাইরে; S3 এর archive ৮ গুণ সংকুচিত ধরে)');

heading('অংশ ঘ — activity table: সব Postgres এ, নাকি ৯০ দিনের পরে S3 এ (Parquet)');
const ACTIVITY_START = env('ACTIVITY_GB', 1_100);
const ACTIVITY_MONTHLY = env('ACTIVITY_MONTHLY_GB', 60);
const COPIES = 4;
const COMPRESSION = 6;
console.log(
	row([
		['নকশা', 44],
		['মাস ১', 10],
		[`মাস ${MONTHS}`, 10],
		[`${MONTHS} মাসে মোট`, 14],
		[`মাস ${MONTHS} এ DB তে`, 16]
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
			[offload ? '৯০ দিন Postgres এ, বাকি S3 এ Parquet' : 'সব Postgres এ (৪ কপি + backup)', 44],
			[usd(first), 10],
			[usd(last), 10],
			[usd(sum), 14],
			[tb(dbGb), 16]
		])
	);
}
