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
			['design', 52],
			['GB / month', 12],
			['cost / month', 14],
			['', 2],
			['note', 52]
		])
	);
	for (const o of options)
		console.log(
			row([
				[o.name, 52],
				[tb(o.gb), 12],
				[usd(o.cost), 14],
				['', 2],
				[`  ${o.note}`, 52]
			])
		);
}

const apiGb = REQUESTS * API_KB * KB;
const cdnRequestsFee = (ATTACHMENT_GETS / 10_000) * P.cdnPer10kRequests;
table(
	`Part A - going out (egress): ${n(REQUESTS / 1e6)} M API requests a month, ${tb(ATTACHMENT_GB)} of attachments`,
	[
		{
			name: 'API JSON, no compression',
			gb: apiGb,
			cost: apiGb * P.internetEgressGb,
			note: `${API_KB} KB on average`
		},
		{
			name: `API JSON, gzip/br (~${COMPRESSION}×)`,
			gb: apiGb / COMPRESSION,
			cost: (apiGb / COMPRESSION) * P.internetEgressGb,
			note: 'the CPU cost is tiny'
		},
		{
			name: 'attachments straight from S3',
			gb: ATTACHMENT_GB,
			cost: ATTACHMENT_GB * P.internetEgressGb + (ATTACHMENT_GETS / 1_000) * P.s3GetPer1k,
			note: 'S3 egress + GET'
		},
		{
			name: `attachments through a CDN (hit ${Math.round(CDN_HIT * 100)}%)`,
			gb: ATTACHMENT_GB,
			cost:
				ATTACHMENT_GB * P.cdnEgressGb +
				cdnRequestsFee +
				((ATTACHMENT_GETS * (1 - CDN_HIT)) / 1_000) * P.s3GetPer1k,
			note: 'S3 → CDN assumed free within one provider'
		},
		{
			name: 'CDN + small previews on the board (40% bytes)',
			gb: ATTACHMENT_GB * 0.4,
			cost:
				ATTACHMENT_GB * 0.4 * P.cdnEgressGb +
				cdnRequestsFee +
				((ATTACHMENT_GETS * (1 - CDN_HIT)) / 1_000) * P.s3GetPer1k,
			note: 'resize once, at upload time (8.2)'
		}
	]
);

const imageGb = DEPLOYS_PER_DAY * 30 * INSTANCES * IMAGE_GB;
const natFlows = S3_WORKER_GB + imageGb + LOG_SHIP_GB;
const natHours = (gateways: number): number => gateways * P.natGatewayHour * H;
const endpointHours = AZS * P.interfaceEndpointHour * H;
table(
	`Part B - out of the private subnet: S3 ${tb(S3_WORKER_GB)}, image pulls ${tb(imageGb)} (${DEPLOYS_PER_DAY} deploys a day × ${INSTANCES} instances × ${IMAGE_GB * 1_000} MB), logs ${tb(LOG_SHIP_GB)}`,
	[
		{
			name: 'everything through NAT, one NAT per AZ',
			gb: natFlows,
			cost: natHours(AZS) + natFlows * P.natPerGb,
			note: "today's TaskFlow"
		},
		{
			name: '+ S3 gateway endpoint',
			gb: natFlows - S3_WORKER_GB,
			cost: natHours(AZS) + (imageGb + LOG_SHIP_GB) * P.natPerGb,
			note: 'the gateway endpoint is free'
		},
		{
			name: '+ an interface endpoint for images',
			gb: LOG_SHIP_GB,
			cost:
				natHours(AZS) + LOG_SHIP_GB * P.natPerGb + endpointHours + imageGb * P.interfaceEndpointGb,
			note: 'hourly + per GB, less than NAT'
		},
		{
			name: '+ smaller images (500 → 150 MB)',
			gb: LOG_SHIP_GB,
			cost:
				natHours(AZS) +
				LOG_SHIP_GB * P.natPerGb +
				endpointHours +
				imageGb * 0.3 * P.interfaceEndpointGb,
			note: 'multi-stage build, runtime only'
		},
		{
			name: 'everything through NAT, but one NAT for three AZs',
			gb: natFlows,
			cost: natHours(1) + natFlows * P.natPerGb + natFlows * remote * crossAz,
			note: 'fewer NAT hours, more cross-AZ, a SPOF in one AZ'
		},
		{
			name: 'with endpoints, one NAT for three AZs',
			gb: LOG_SHIP_GB,
			cost:
				natHours(1) +
				LOG_SHIP_GB * P.natPerGb +
				LOG_SHIP_GB * remote * crossAz +
				endpointHours +
				imageGb * P.interfaceEndpointGb,
			note: 'cheap - but if that AZ dies, nothing gets out'
		}
	]
);

const callGb = REQUESTS * CALLS_PER_REQUEST * CALL_KB * KB;
const dbGb = REQUESTS * DB_KB * KB;
const dbWrites = dbGb * (1 - READ_SHARE);
table(
	`Part C - across AZs: ${CALLS_PER_REQUEST} internal calls per request × ${CALL_KB} KB, ${DB_KB} KB to the DB (${Math.round(READ_SHARE * 100)}% reads), ${AZS} AZs`,
	[
		{
			name: 'monolith: internal calls are function calls',
			gb: dbGb * remote,
			cost: dbGb * remote * crossAz,
			note: 'only app → primary'
		},
		{
			name: 'services, sent to any AZ',
			gb: callGb * remote + dbGb * remote,
			cost: (callGb * remote + dbGb * remote) * crossAz,
			note: `${Math.round(remote * 100)}% of internal calls to another AZ`
		},
		{
			name: 'services, same AZ first (AZ-aware)',
			gb: callGb * 0.1 + dbGb * remote,
			cost: (callGb * 0.1 + dbGb * remote) * crossAz,
			note: '10% to another AZ (fallback)'
		},
		{
			name: '+ a read replica in every AZ',
			gb: callGb * 0.1 + dbWrites * remote,
			cost: (callGb * 0.1 + dbWrites * remote) * crossAz,
			note: 'reads in their own AZ, writes to the primary'
		}
	]
);
console.log(
	`\n(cross-AZ is charged both ways - sending and receiving - at ${usd(P.crossAzGbEachWay)} per GB each; replication traffic for building replicas is not counted here)`
);
