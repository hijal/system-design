import { HOURS_PER_MONTH as H, PRICE as P } from './prices';
import { env, heading, n, row, tb, usd } from './util';

const RPS = env('RPS', 300);
const REQUESTS = RPS * 30 * 86_400;
const API_KB = env('API_KB', 25);
const COMPRESSION = env('COMPRESSION', 5);
const ATTACHMENT_GB = env('ATTACHMENT_GB', 7_500);
const ATTACHMENT_GETS = env('ATTACHMENT_GETS', 30_000_000);
const CDN_HIT = env('CDN_HIT', 0.9);
const S3_WORKER_GB = env('S3_WORKER_GB', 60_000);
const DEPLOYS_PER_DAY = env('DEPLOYS_PER_DAY', 6);
const INSTANCES = env('INSTANCES', 40);
const IMAGE_GB = env('IMAGE_GB', 0.5);
const LOG_SHIP_GB = env('LOG_SHIP_GB', 900);
const CALLS_PER_REQUEST = env('CALLS_PER_REQUEST', 6);
const CALL_KB = env('CALL_KB', 30);
const DB_KB = env('DB_KB', 40);
const READ_SHARE = env('READ_SHARE', 0.8);
const AZS = 3;

const KB = 1 / 1_000_000;
const crossAz = 2 * P.crossAzGbEachWay;
const remote = (AZS - 1) / AZS;

type Option = { name: string; gb: number; cost: number; note: string };

function table(title: string, options: Option[]): void {
	heading(title);
	console.log(
		row([
			['নকশা', 46],
			['GB / মাস', 12],
			['খরচ / মাস', 12],
			['', 2],
			['নোট', 40]
		])
	);
	for (const o of options)
		console.log(
			row([
				[o.name, 46],
				[tb(o.gb), 12],
				[usd(o.cost), 12],
				['', 2],
				[`  ${o.note}`, 40]
			])
		);
}

const apiGb = REQUESTS * API_KB * KB;
const cdnRequestsFee = (ATTACHMENT_GETS / 10_000) * P.cdnPer10kRequests;
table(
	`অংশ ক — বাইরে যাওয়া (egress): মাসে ${n(REQUESTS / 1e6)} M API request, ${tb(ATTACHMENT_GB)} attachment`,
	[
		{
			name: 'API JSON, compression নেই',
			gb: apiGb,
			cost: apiGb * P.internetEgressGb,
			note: `গড় ${API_KB} KB`
		},
		{
			name: `API JSON, gzip/br (~${COMPRESSION} গুণ)`,
			gb: apiGb / COMPRESSION,
			cost: (apiGb / COMPRESSION) * P.internetEgressGb,
			note: 'CPU এর দাম সামান্য'
		},
		{
			name: 'attachment সরাসরি S3 থেকে',
			gb: ATTACHMENT_GB,
			cost: ATTACHMENT_GB * P.internetEgressGb + (ATTACHMENT_GETS / 1_000) * P.s3GetPer1k,
			note: 'S3 egress + GET'
		},
		{
			name: `attachment CDN দিয়ে (hit ${Math.round(CDN_HIT * 100)}%)`,
			gb: ATTACHMENT_GB,
			cost:
				ATTACHMENT_GB * P.cdnEgressGb +
				cdnRequestsFee +
				((ATTACHMENT_GETS * (1 - CDN_HIT)) / 1_000) * P.s3GetPer1k,
			note: 'S3 → CDN একই provider এ ধরা বিনা মূল্যে'
		},
		{
			name: 'CDN + board এ ছোট preview (৪০% bytes)',
			gb: ATTACHMENT_GB * 0.4,
			cost:
				ATTACHMENT_GB * 0.4 * P.cdnEgressGb +
				cdnRequestsFee +
				((ATTACHMENT_GETS * (1 - CDN_HIT)) / 1_000) * P.s3GetPer1k,
			note: 'resize একবার, upload এর সময় (8.2)'
		}
	]
);

const imageGb = DEPLOYS_PER_DAY * 30 * INSTANCES * IMAGE_GB;
const natFlows = S3_WORKER_GB + imageGb + LOG_SHIP_GB;
const natHours = (gateways: number): number => gateways * P.natGatewayHour * H;
const endpointHours = AZS * P.interfaceEndpointHour * H;
table(
	`অংশ খ — private subnet থেকে বাইরে: S3 ${tb(S3_WORKER_GB)}, image pull ${tb(imageGb)} (দিনে ${DEPLOYS_PER_DAY} deploy × ${INSTANCES} instance × ${IMAGE_GB * 1_000} MB), log ${tb(LOG_SHIP_GB)}`,
	[
		{
			name: 'সব NAT দিয়ে, প্রতি AZ এ একটা NAT',
			gb: natFlows,
			cost: natHours(AZS) + natFlows * P.natPerGb,
			note: 'আজকের TaskFlow'
		},
		{
			name: '+ S3 gateway endpoint',
			gb: natFlows - S3_WORKER_GB,
			cost: natHours(AZS) + (imageGb + LOG_SHIP_GB) * P.natPerGb,
			note: 'gateway endpoint বিনা মূল্যে'
		},
		{
			name: '+ image এর জন্য interface endpoint',
			gb: LOG_SHIP_GB,
			cost:
				natHours(AZS) + LOG_SHIP_GB * P.natPerGb + endpointHours + imageGb * P.interfaceEndpointGb,
			note: 'ঘণ্টা + প্রতি GB, NAT এর চেয়ে কম'
		},
		{
			name: '+ image ছোট করা (৫০০ → ১৫০ MB)',
			gb: LOG_SHIP_GB,
			cost:
				natHours(AZS) +
				LOG_SHIP_GB * P.natPerGb +
				endpointHours +
				imageGb * 0.3 * P.interfaceEndpointGb,
			note: 'multi-stage build, শুধু runtime'
		},
		{
			name: 'সব NAT দিয়ে, কিন্তু তিন AZ এ একটাই NAT',
			gb: natFlows,
			cost: natHours(1) + natFlows * P.natPerGb + natFlows * remote * crossAz,
			note: 'NAT এর ঘণ্টা কম, cross-AZ বেশি, এক AZ এ SPOF'
		},
		{
			name: 'endpoint সহ, তিন AZ এ একটাই NAT',
			gb: LOG_SHIP_GB,
			cost:
				natHours(1) +
				LOG_SHIP_GB * P.natPerGb +
				LOG_SHIP_GB * remote * crossAz +
				endpointHours +
				imageGb * P.interfaceEndpointGb,
			note: 'সস্তা — কিন্তু সেই AZ মরলে বাইরে যাওয়া বন্ধ'
		}
	]
);

const callGb = REQUESTS * CALLS_PER_REQUEST * CALL_KB * KB;
const dbGb = REQUESTS * DB_KB * KB;
const dbWrites = dbGb * (1 - READ_SHARE);
table(
	`অংশ গ — AZ জুড়ে: প্রতি request এ ${CALLS_PER_REQUEST}টা ভেতরের call × ${CALL_KB} KB, DB তে ${DB_KB} KB (${Math.round(READ_SHARE * 100)}% পড়া), ${AZS}টা AZ`,
	[
		{
			name: 'monolith: ভেতরের call function এ',
			gb: dbGb * remote,
			cost: dbGb * remote * crossAz,
			note: 'শুধু app → primary'
		},
		{
			name: 'service, যেকোনো AZ এ পাঠানো',
			gb: callGb * remote + dbGb * remote,
			cost: (callGb * remote + dbGb * remote) * crossAz,
			note: `ভেতরের call এর ${Math.round(remote * 100)}% অন্য AZ এ`
		},
		{
			name: 'service, একই AZ আগে (AZ-aware)',
			gb: callGb * 0.1 + dbGb * remote,
			cost: (callGb * 0.1 + dbGb * remote) * crossAz,
			note: '১০% অন্য AZ এ (fallback)'
		},
		{
			name: '+ প্রতি AZ এ একটা read replica',
			gb: callGb * 0.1 + dbWrites * remote,
			cost: (callGb * 0.1 + dbWrites * remote) * crossAz,
			note: 'পড়া নিজের AZ এ, লেখা primary তে'
		}
	]
);
console.log(
	`\n(cross-AZ এর দাম দুই দিকেই — পাঠানো আর পাওয়া — প্রতি GB ${usd(P.crossAzGbEachWay)} করে ধরা; replica তৈরির replication traffic এখানে ধরা না)`
);
