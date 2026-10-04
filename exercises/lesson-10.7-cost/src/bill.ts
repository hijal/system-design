import { POLICIES, WEEK, bestCommitment, commitmentCost, monthly, simulate } from './fleet';
import { HOURS_PER_MONTH as H, PRICE as P } from './prices';
import { env, heading, mulberry32, n, normal, pct, row, usd } from './util';

const RPS = env('RPS', 300);
const MONTH_SECONDS = 30 * 86_400;
const REQUESTS = RPS * MONTH_SECONDS;
const MAU = env('MAU', 60_000);
const WORKSPACES = env('WORKSPACES', 2_000);
const SEED = env('SEED', 1_070);

const GB = 1_000_000;
const KB = 1 / GB;

type Line = {
	group: 'compute' | 'database' | 'network' | 'storage' | 'observability' | 'other';
	name: string;
	now: number;
	after: number;
	why: string;
};

const app = P.appInstanceHour * H;
const fixedPolicy = POLICIES.find((p) => p.kind === 'fixed');
const reactivePolicy = POLICIES.find((p) => p.kind === 'reactive');
if (!fixedPolicy || !reactivePolicy) throw new Error('fleet এর নীতি পাওয়া যায়নি');
const fixedRun = simulate(fixedPolicy);
const reactiveRun = simulate(reactivePolicy);
const fixedInstances = fixedRun.instanceMinutes / WEEK;
const autoscaleAvg = reactiveRun.instanceMinutes / WEEK;
const committedApp = bestCommitment(reactiveRun.hourly);
const small = P.smallInstanceHour * H;
const keep = 1 - P.commitDiscount;
const crossAz = 2 * P.crossAzGbEachWay;

const serviceCallGb = REQUESTS * 6 * 30 * KB;
const dbTrafficGb = REQUESTS * 40 * KB;
const apiEgressGb = REQUESTS * 25 * KB;
const attachmentEgressGb = 7_500;
const s3ViaNatGb = 60_000;
const imagePullGb = 3_600;
const logShipGb = 900;
const debugLogGbDay = 45;
const baseLogGbDay = 2.8;
const sampledLogGbDay = 1.5;

const LINES: Line[] = [
	{
		group: 'compute',
		name: `app instance (peak এর মাপে, ${Math.round(fixedInstances)}টা ২৪/৭)`,
		now: monthly(fixedRun.cost),
		after: commitmentCost(reactiveRun.hourly, committedApp).cost,
		why: `autoscale (গড় ${autoscaleAvg.toFixed(1)}), ${committedApp}টা commit`
	},
	{
		group: 'compute',
		name: 'background worker',
		now: 4 * app,
		after: 4 * app * P.spotShare,
		why: 'spot (job idempotent, 7.4)'
	},
	{
		group: 'compute',
		name: 'gateway + BFF + billing + files',
		now: 11 * small,
		after: 11 * small * keep,
		why: 'commit (সারাক্ষণ চলে)'
	},
	{
		group: 'compute',
		name: 'blue-green এর না-মোছা pool',
		now: Math.round(fixedInstances) * P.appInstanceHour * 6 * 30,
		after: 3 * P.appInstanceHour * 1 * 30,
		why: 'teardown ঠিক; canary +৩, দিনে ১ ঘ'
	},
	{
		group: 'observability',
		name: 'trace collector',
		now: 4 * small,
		after: 2 * small,
		why: 'মাপ ঠিক করা'
	},
	{
		group: 'database',
		name: 'Postgres primary (Multi-AZ)',
		now: 2 * P.dbInstanceHour * H,
		after: 2 * P.dbInstanceHour * H * keep,
		why: 'commit'
	},
	{
		group: 'database',
		name: 'Postgres read replica ×২',
		now: 2 * P.dbInstanceHour * H,
		after: 2 * P.dbInstanceHour * H * keep,
		why: 'commit'
	},
	{
		group: 'database',
		name: 'Postgres storage (২ TB × ৪ কপি)',
		now: 2_000 * 4 * P.dbStorageGbMonth,
		after: 900 * 4 * P.dbStorageGbMonth,
		why: '৯০ দিনের পুরনো activity S3 এ'
	},
	{
		group: 'database',
		name: 'backup snapshot',
		now: 6_000 * P.backupGbMonth,
		after: 3_000 * P.backupGbMonth,
		why: '৩০ → ১৪ দিন রাখা'
	},
	{
		group: 'database',
		name: 'Redis (cache ৩ + queue ২)',
		now: 5 * P.cacheNodeHour * H,
		after: 5 * P.cacheNodeHour * H * keep,
		why: 'commit'
	},
	{
		group: 'other',
		name: 'staging + dev (prod এর মাপে, ২৪/৭)',
		now:
			(Math.round(fixedInstances) * P.appInstanceHour +
				2 * P.dbInstanceHour +
				3 * P.cacheNodeHour) *
			H,
		after:
			(Math.round(fixedInstances) * P.appInstanceHour +
				2 * P.dbInstanceHour +
				3 * P.cacheNodeHour) *
			H *
			0.25 *
			(60 / 168),
		why: '¼ মাপ, শুধু কাজের সময়'
	},
	{
		group: 'network',
		name: 'load balancer',
		now: 2 * P.loadBalancerMonth,
		after: 2 * P.loadBalancerMonth,
		why: '—'
	},
	{
		group: 'network',
		name: 'NAT gateway (ঘণ্টা + প্রতি GB)',
		now: 3 * P.natGatewayHour * H + (s3ViaNatGb + imagePullGb + logShipGb) * P.natPerGb,
		after: 3 * P.natGatewayHour * H + logShipGb * P.natPerGb,
		why: 'S3 gateway endpoint, image endpoint'
	},
	{
		group: 'network',
		name: 'VPC interface endpoint (image pull)',
		now: 0,
		after: 3 * P.interfaceEndpointHour * H + imagePullGb * P.interfaceEndpointGb,
		why: 'NAT এর বদলে'
	},
	{
		group: 'network',
		name: 'internet egress: API এর JSON',
		now: apiEgressGb * P.internetEgressGb,
		after: (apiEgressGb / 5) * P.internetEgressGb,
		why: 'gzip/br (~৫ গুণ ছোট)'
	},
	{
		group: 'network',
		name: 'internet egress: attachment',
		now: attachmentEgressGb * P.internetEgressGb,
		after: attachmentEgressGb * P.cdnEgressGb + (30_000_000 / 10_000) * P.cdnPer10kRequests,
		why: 'CDN (দামে প্রায় একই)'
	},
	{
		group: 'network',
		name: 'cross-AZ: service → service',
		now: serviceCallGb * (2 / 3) * crossAz,
		after: serviceCallGb * 0.1 * crossAz,
		why: 'AZ-aware routing'
	},
	{
		group: 'network',
		name: 'cross-AZ: app → database',
		now: dbTrafficGb * (2 / 3) * crossAz,
		after: dbTrafficGb * 0.2 * (2 / 3) * crossAz,
		why: 'প্রতি AZ এ read replica'
	},
	{
		group: 'storage',
		name: 'S3: attachment + পুরনো version',
		now: 18_000 * P.s3StandardGbMonth + 14_000 * P.s3StandardGbMonth,
		after:
			18_000 * 0.3 * P.s3StandardGbMonth +
			18_000 * 0.7 * P.s3IaGbMonth +
			1_400 * P.s3StandardGbMonth,
		why: 'lifecycle: version ৩০ দিন, IA'
	},
	{
		group: 'storage',
		name: 'S3 request',
		now: 50_000 * P.s3GetPer1k + 5_000 * P.s3PutPer1k,
		after: 50_000 * P.s3GetPer1k + 5_000 * P.s3PutPer1k,
		why: '—'
	},
	{
		group: 'observability',
		name: 'log ingest + ৯০ দিন রাখা',
		now:
			(baseLogGbDay + debugLogGbDay) * 30 * P.logIngestGb +
			(baseLogGbDay + debugLogGbDay) * 90 * P.logStoreGbMonth,
		after: sampledLogGbDay * 30 * P.logIngestGb + sampledLogGbDay * 14 * P.logStoreGbMonth,
		why: 'debug বন্ধ, সফল request sample, ১৪ দিন'
	},
	{
		group: 'observability',
		name: 'metric series',
		now: 60_000 * P.metricSeriesMonth,
		after: 30_000 * P.metricSeriesMonth,
		why: 'label পরিষ্কার (10.4)'
	},
	{
		group: 'observability',
		name: 'trace জমা (tail sampling)',
		now: 3 * 30 * P.traceIngestGb,
		after: 3 * 30 * P.traceIngestGb,
		why: '—'
	}
];

const total = (pick: (l: Line) => number): number => LINES.reduce((sum, l) => sum + pick(l), 0);
const nowTotal = total((l) => l.now);
const afterTotal = total((l) => l.after);

heading(
	`অংশ ক — TaskFlow এর মাসিক বিল: ${n(MAU)} MAU, ${n(WORKSPACES)} workspace, ${RPS} req/s (মাসে ${n(REQUESTS / 1e6)} M request)`
);
console.log(
	row([
		['লাইন', 40],
		['এখন', 10],
		['এখন %', 8],
		['পরে', 10],
		['বাঁচল', 10],
		['কী বদলাল', 40]
	])
);
for (const line of [...LINES].sort((a, b) => b.now - a.now)) {
	console.log(
		row([
			[line.name, 40],
			[usd(line.now), 10],
			[pct(line.now, nowTotal), 8],
			[usd(line.after), 10],
			[usd(line.now - line.after), 10],
			[`  ${line.why}`, 40]
		])
	);
}
console.log(
	row([
		['মোট', 40],
		[usd(nowTotal), 10],
		['100%', 8],
		[usd(afterTotal), 10],
		[usd(nowTotal - afterTotal), 10],
		[`  ${pct(nowTotal - afterTotal, nowTotal, 0)} কম`, 40]
	])
);

const groups: Line['group'][] = [
	'compute',
	'database',
	'network',
	'storage',
	'observability',
	'other'
];
console.log('\nভাগ ধরে:');
for (const g of groups) {
	const now = LINES.filter((l) => l.group === g).reduce((s, l) => s + l.now, 0);
	const after = LINES.filter((l) => l.group === g).reduce((s, l) => s + l.after, 0);
	console.log(
		row([
			[`  ${g}`, 18],
			[usd(now), 10],
			[pct(now, nowTotal, 0), 6],
			[usd(after), 10]
		])
	);
}
console.log('\nএকক ধরে (unit cost):');
console.log(
	row([
		['  প্রতি workspace / মাস', 30],
		[usd(nowTotal / WORKSPACES), 10],
		[usd(afterTotal / WORKSPACES), 10]
	])
);
console.log(
	row([
		['  প্রতি MAU / মাস', 30],
		[usd(nowTotal / MAU), 10],
		[usd(afterTotal / MAU), 10]
	])
);
console.log(
	row([
		['  প্রতি ১০ লাখ request', 30],
		[usd(nowTotal / (REQUESTS / 1e6)), 10],
		[usd(afterTotal / (REQUESTS / 1e6)), 10]
	])
);

type Plan = {
	name: string;
	workspaces: number;
	seats: number;
	pricePerSeat: number;
	requestShare: number;
	storageGb: number;
	egressGb: number;
};
const PLANS: Plan[] = [
	{
		name: 'free',
		workspaces: 1_399,
		seats: 25_000,
		pricePerSeat: 0,
		requestShare: 0.3,
		storageGb: 3_000,
		egressGb: 2_300
	},
	{
		name: 'free: একটা school district',
		workspaces: 1,
		seats: 3_000,
		pricePerSeat: 0,
		requestShare: 0.05,
		storageGb: 2_000,
		egressGb: 1_200
	},
	{
		name: 'pro',
		workspaces: 500,
		seats: 15_000,
		pricePerSeat: 6,
		requestShare: 0.3,
		storageGb: 6_000,
		egressGb: 2_000
	},
	{
		name: 'business',
		workspaces: 100,
		seats: 17_000,
		pricePerSeat: 10,
		requestShare: 0.35,
		storageGb: 7_000,
		egressGb: 2_000
	}
];
const storageGroup = (l: Line): boolean =>
	l.group === 'storage' || l.name.startsWith('backup') || l.name.startsWith('Postgres storage');
const egressGroup = (l: Line): boolean => l.name.includes('attachment') && l.group === 'network';
const sharedGroup = (l: Line): boolean => l.group === 'other' || l.name === 'load balancer';
const allocate = (pick: (l: Line) => number, plan: Plan): number => {
	const totalStorage = PLANS.reduce((s, p) => s + p.storageGb, 0);
	const totalEgress = PLANS.reduce((s, p) => s + p.egressGb, 0);
	const totalSeats = PLANS.reduce((s, p) => s + p.seats, 0);
	let cost = 0;
	for (const l of LINES) {
		const v = pick(l);
		if (storageGroup(l)) cost += (v * plan.storageGb) / totalStorage;
		else if (egressGroup(l)) cost += (v * plan.egressGb) / totalEgress;
		else if (sharedGroup(l)) cost += (v * plan.seats) / totalSeats;
		else cost += v * plan.requestShare;
	}
	return cost;
};

heading('অংশ খ — unit economics: plan ধরে আয় বনাম ভাগ করা খরচ (এখনকার বিল)');
console.log(
	row([
		['plan', 28],
		['workspace', 10],
		['seat', 8],
		['আয়', 10],
		['খরচ', 10],
		['margin', 10],
		['খরচ / seat', 12],
		['খরচ / workspace', 16]
	])
);
let revenueTotal = 0;
for (const plan of PLANS) {
	const revenue = plan.seats * plan.pricePerSeat;
	revenueTotal += revenue;
	const cost = allocate((l) => l.now, plan);
	console.log(
		row([
			[plan.name, 28],
			[n(plan.workspaces), 10],
			[n(plan.seats), 8],
			[usd(revenue), 10],
			[usd(cost), 10],
			[revenue === 0 ? '—' : pct(revenue - cost, revenue, 0), 10],
			[usd(cost / plan.seats), 12],
			[usd(cost / plan.workspaces), 16]
		])
	);
}
console.log(
	`\nমোট আয় ${usd(revenueTotal)} / মাস; বিল এখন ${usd(nowTotal)} (${pct(nowTotal, revenueTotal)}), পরে ${usd(afterTotal)} (${pct(afterTotal, revenueTotal)})`
);
console.log(
	'(খরচ ভাগ: compute/DB/cache/observability/cross-AZ — request এর অংশে; storage আর backup — GB এ; attachment egress — GB এ; staging/LB — seat এ)'
);

type Endpoint = {
	name: string;
	callsPerMonth: number;
	appCpuMs: number;
	dbCpuMs: number;
	outKb: number;
	internalKb: number;
	s3Mb: number;
	s3Gets: number;
};
const ENDPOINTS: Endpoint[] = [
	{
		name: 'GET /boards/:id',
		callsPerMonth: 400e6,
		appCpuMs: 4,
		dbCpuMs: 1,
		outKb: 25,
		internalKb: 180,
		s3Mb: 0,
		s3Gets: 0
	},
	{
		name: 'POST /tasks',
		callsPerMonth: 50e6,
		appCpuMs: 6,
		dbCpuMs: 3,
		outKb: 2,
		internalKb: 60,
		s3Mb: 0,
		s3Gets: 0
	},
	{
		name: 'GET /search',
		callsPerMonth: 20e6,
		appCpuMs: 15,
		dbCpuMs: 25,
		outKb: 12,
		internalKb: 30,
		s3Mb: 0,
		s3Gets: 0
	},
	{
		name: 'POST /boards/:id/export',
		callsPerMonth: 60_000,
		appCpuMs: 2_000,
		dbCpuMs: 300,
		outKb: 80_000,
		internalKb: 200,
		s3Mb: 80,
		s3Gets: 200
	}
];
const appCpuMsPrice = P.appInstanceHour / 4 / 3_600_000;
const dbCpuMsPrice = P.dbInstanceHour / 8 / 3_600_000;
const callCost = (e: Endpoint): number =>
	e.appCpuMs * appCpuMsPrice +
	e.dbCpuMs * dbCpuMsPrice +
	e.outKb * KB * P.internetEgressGb +
	e.internalKb * KB * (2 / 3) * crossAz +
	(e.s3Mb / 1_000) * P.natPerGb +
	(e.s3Gets / 1_000) * P.s3GetPer1k;

heading('অংশ গ — endpoint ধরে খরচ (এখনকার নকশা, শুধু পরিবর্তনশীল খরচ)');
console.log(
	row([
		['endpoint', 26],
		['call / মাস', 14],
		['প্রতি call', 12],
		['প্রতি ১০ লাখ', 14],
		['মাসে', 10],
		['call এর %', 10],
		['খরচের %', 10]
	])
);
const endpointTotal = ENDPOINTS.reduce((s, e) => s + callCost(e) * e.callsPerMonth, 0);
const callsTotal = ENDPOINTS.reduce((s, e) => s + e.callsPerMonth, 0);
for (const e of ENDPOINTS) {
	const monthly = callCost(e) * e.callsPerMonth;
	console.log(
		row([
			[e.name, 26],
			[n(e.callsPerMonth), 14],
			[usd(callCost(e)), 12],
			[usd(callCost(e) * 1e6), 14],
			[usd(monthly), 10],
			[pct(e.callsPerMonth, callsTotal, 3), 10],
			[pct(monthly, endpointTotal, 0), 10]
		])
	);
}

type Category = { name: string; daily: number; volatility: number };
const after = (name: string): number => (LINES.find((l) => l.name === name)?.after ?? 0) / 30;
const CATEGORIES: Category[] = [
	{
		name: 'compute',
		daily: LINES.filter((l) => l.group === 'compute').reduce((s, l) => s + l.after, 0) / 30,
		volatility: 0.04
	},
	{
		name: 'database',
		daily: LINES.filter((l) => l.group === 'database').reduce((s, l) => s + l.after, 0) / 30,
		volatility: 0.01
	},
	{
		name: 'network',
		daily: LINES.filter((l) => l.group === 'network').reduce((s, l) => s + l.after, 0) / 30,
		volatility: 0.06
	},
	{
		name: 'storage',
		daily: LINES.filter((l) => l.group === 'storage').reduce((s, l) => s + l.after, 0) / 30,
		volatility: 0.01
	},
	{ name: 'log ingest', daily: after('log ingest + ৯০ দিন রাখা'), volatility: 0.08 },
	{
		name: 'বাকি observability',
		daily:
			LINES.filter((l) => l.group === 'observability' && !l.name.startsWith('log')).reduce(
				(s, l) => s + l.after,
				0
			) / 30,
		volatility: 0.02
	},
	{
		name: 'other',
		daily: LINES.filter((l) => l.group === 'other').reduce((s, l) => s + l.after, 0) / 30,
		volatility: 0.02
	}
];
const DAYS = 60;
const DEBUG_DAY = 41;
const EXPORT_DAY = 50;
const debugExtra = debugLogGbDay * P.logIngestGb;
const exportExtra = 2_000 * (P.natPerGb + P.internetEgressGb);
const series = new Map<string, number[]>();
const random = mulberry32(SEED);
for (const c of CATEGORIES) {
	const values: number[] = [];
	for (let d = 0; d < DAYS; d++) {
		const growth = 1 + 0.003 * d;
		const weekend = d % 7 >= 5 && (c.name === 'compute' || c.name === 'network') ? 0.8 : 1;
		let v = c.daily * growth * weekend * (1 + c.volatility * normal(random));
		if (c.name === 'log ingest' && d >= DEBUG_DAY) v += debugExtra;
		if (c.name === 'network' && d >= EXPORT_DAY) v += exportExtra;
		values.push(v);
	}
	series.set(c.name, values);
}
const dayTotal = (d: number): number => [...series.values()].reduce((s, v) => s + (v[d] ?? 0), 0);

type Detector = { name: string; fires: (d: number) => boolean };
const avg7 = (values: number[], d: number): number => {
	let s = 0;
	for (let k = d - 7; k < d; k++) s += values[k] ?? 0;
	return s / 7;
};
const totals = Array.from({ length: DAYS }, (_, d) => dayTotal(d));
const budget = totals.slice(0, 30).reduce((a, b) => a + b, 0) * 1.1;
const DETECTORS: Detector[] = [
	{
		name: 'মাসের budget ছাড়ালে (আগের মাস +১০%)',
		fires: (d) => d >= 30 && totals.slice(30, d + 1).reduce((a, b) => a + b, 0) > budget
	},
	{
		name: 'মাস শেষের forecast > budget',
		fires: (d) => {
			if (d < 30) return false;
			const sofar = totals.slice(30, d + 1);
			const projected = (sofar.reduce((a, b) => a + b, 0) / sofar.length) * 30;
			return sofar.length >= 3 && projected > budget;
		}
	},
	{
		name: 'মোট দৈনিক > ৭ দিনের গড় × ১.২',
		fires: (d) => d >= 7 && (totals[d] ?? 0) > avg7(totals, d) * 1.2
	},
	{
		name: 'প্রতি ভাগ দৈনিক > নিজের ৭ দিনের গড় × ১.৫',
		fires: (d) =>
			d >= 7 && [...series.values()].some((values) => (values[d] ?? 0) > avg7(values, d) * 1.5)
	}
];

heading(
	`অংশ ঘ — cost anomaly: দিন ${DEBUG_DAY + 1} এ তিনটা service এ debug log (+${usd(debugExtra)}/দিন), দিন ${EXPORT_DAY + 1} এ একটা export এর loop (+${usd(exportExtra)}/দিন)`
);
console.log(
	`দৈনিক বিল ~${usd(totals[DEBUG_DAY - 1] ?? 0)}; debug log মোটের ${pct(debugExtra, totals[DEBUG_DAY - 1] ?? 1)}, export এর loop ${pct(exportExtra, totals[EXPORT_DAY - 1] ?? 1)}\n`
);
console.log(
	row([
		['detector', 46],
		['debug log ধরল', 16],
		['export loop ধরল', 18],
		['মিথ্যা alarm (দিন ১–৪০)', 22]
	])
);
for (const det of DETECTORS) {
	let debugAt: number | null = null;
	let exportAt: number | null = null;
	let falseAlarms = 0;
	for (let d = 0; d < DAYS; d++) {
		const fired = det.fires(d);
		if (!fired) continue;
		if (d < DEBUG_DAY) falseAlarms++;
		else if (d < EXPORT_DAY && debugAt === null) debugAt = d;
		else if (d >= EXPORT_DAY && exportAt === null) exportAt = d;
	}
	const show = (at: number | null, start: number): string =>
		at === null ? 'ধরেনি' : `${at - start + 1} দিন পরে`;
	console.log(
		row([
			[det.name, 46],
			[show(debugAt, DEBUG_DAY), 16],
			[show(exportAt, EXPORT_DAY), 18],
			[n(falseAlarms), 22]
		])
	);
}
