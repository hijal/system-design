import {
	AVG_RPS,
	BOOT_MINUTES,
	PER_INSTANCE,
	POLICIES,
	TARGET,
	WEEK,
	bestCommitment,
	commitmentCost,
	demand,
	monthly,
	peak,
	simulate,
	type Policy,
	type Result
} from './fleet';
import { PRICE as P } from './prices';
import { heading, n, pct, row, usd } from './util';

const weekRequests = demand.reduce((a, b) => a + b, 0) * 60;
heading(
	`অংশ ক — এক সপ্তাহ: গড় ${AVG_RPS} req/s, peak ${n(peak)} req/s (বুধবার ১০টায় marketing email), instance প্রতি ${PER_INSTANCE} req/s, চালু হতে ${BOOT_MINUTES} মিনিট`
);
console.log(
	row([
		['নীতি', 36],
		['গড় instance', 13],
		['খরচ / মাস', 12],
		['গড় ব্যবহার', 12],
		['চাপে মিনিট', 11],
		['উপচানো request', 16],
		['spike এ উপচানো', 16],
		['spot হারাল', 11]
	])
);
const results = new Map<Policy['kind'], Result>();
for (const policy of POLICIES) {
	const r = simulate(policy);
	results.set(policy.kind, r);
	console.log(
		row([
			[policy.name, 36],
			[(r.instanceMinutes / WEEK).toFixed(1), 13],
			[usd(monthly(r.cost)), 12],
			[pct(r.utilization, 1, 0), 12],
			[n(r.overloadedMinutes), 11],
			[`${n(r.excessRequests)} (${pct(r.excessRequests, weekRequests, 2)})`, 16],
			[n(r.spikeExcess), 16],
			[n(r.interruptions), 11]
		])
	);
}
console.log(
	'\n("উপচানো request" = সেই মিনিটে capacity এর বেশি আসা request — ধীর, queue তে, বা 503; "spike এ" = বুধবারের ৩ ঘণ্টা)'
);

const reactive = results.get('reactive');
if (reactive) {
	const usage = reactive.hourly;
	const maxUse = Math.ceil(Math.max(...usage));
	heading(
		`অংশ খ — commitment (savings plan / reserved): reactive এর ঘণ্টা ধরে ব্যবহারের উপর, ছাড় ${Math.round(P.commitDiscount * 100)}%`
	);
	console.log(
		row([
			['commit (instance)', 18],
			['খরচ / মাস', 12],
			['on-demand এর তুলনায়', 20],
			['ঘণ্টার কত % ব্যবহার ≥ commit', 30],
			['অব্যবহৃত commit', 16]
		])
	);
	const costFor = (c: number): { cost: number; wasted: number } => commitmentCost(usage, c);
	const base = costFor(0).cost;
	const best = bestCommitment(usage);
	const show = new Set([0, 2, 3, 4, 5, 6, 8, 10, 12, maxUse, best]);
	for (const c of [...show].filter((c) => c <= maxUse).sort((a, b) => a - b)) {
		const { cost, wasted } = costFor(c);
		const covered = usage.filter((u) => u >= c).length / usage.length;
		console.log(
			row([
				[`${c}${c === best ? '  ← সবচেয়ে কম' : ''}`, 18],
				[usd(cost), 12],
				[pct(base - cost, base, 1), 20],
				[pct(covered, 1, 0), 30],
				[usd(wasted), 16]
			])
		);
	}
	console.log(
		`\n(নিয়ম: একটা বাড়তি commit লাভজনক যতক্ষণ ব্যবহার তার উপরে থাকে ঘণ্টার > ${Math.round((1 - P.commitDiscount) * 100)}% সময় — অর্থাৎ ছাড়ের উল্টো)`
	);
}

heading(
	'অংশ গ — 10.5 এর L7 flood: ৬০,০০০ req/s, ৪ ঘণ্টা, প্রতি উত্তর ৩০ KB — কোথায় থামালে কত বিল'
);
const FLOOD_RPS = 60_000;
const FLOOD_SECONDS = 4 * 3_600;
const floodRequests = FLOOD_RPS * FLOOD_SECONDS;
type Stop = {
	name: string;
	instances: number;
	egressGb: number;
	egressPrice: number;
	cdnRequests: number;
};
const STOPS: Stop[] = [
	{
		name: 'origin এ autoscale, কোনো সীমা নেই',
		instances: Math.ceil(FLOOD_RPS / (PER_INSTANCE * TARGET)),
		egressGb: (floodRequests * 30) / 1e6,
		egressPrice: P.internetEgressGb,
		cdnRequests: 0
	},
	{
		name: 'origin এ autoscale, সীমা ৪০',
		instances: 40,
		egressGb: (40 * PER_INSTANCE * FLOOD_SECONDS * 30) / 1e6,
		egressPrice: P.internetEgressGb,
		cdnRequests: 0
	},
	{
		name: 'CDN cache থেকে উত্তর (cache key ঠিক)',
		instances: 0,
		egressGb: (floodRequests * 30) / 1e6,
		egressPrice: P.cdnEgressGb,
		cdnRequests: floodRequests
	},
	{
		name: 'edge এ block / challenge (১ KB উত্তর)',
		instances: 0,
		egressGb: (floodRequests * 1) / 1e6,
		egressPrice: P.cdnEgressGb,
		cdnRequests: floodRequests
	}
];
console.log(
	row([
		['কোথায় থামল', 40],
		['বাড়তি instance', 15],
		['compute', 10],
		['data transfer', 14],
		['request এর fee', 15],
		['মোট', 10]
	])
);
for (const s of STOPS) {
	const compute = s.instances * P.appInstanceHour * (FLOOD_SECONDS / 3_600);
	const transfer = s.egressGb * s.egressPrice;
	const fees = (s.cdnRequests / 10_000) * P.cdnPer10kRequests;
	console.log(
		row([
			[s.name, 40],
			[n(s.instances), 15],
			[usd(compute), 10],
			[usd(transfer), 14],
			[usd(fees), 15],
			[usd(compute + transfer + fees), 10]
		])
	);
}
console.log(
	'\n(DDoS এর traffic এর জন্য অনেক CDN/provider বিল মাফ বা আলাদা করে — তাদের শর্ত দেখো; এখানে তালিকা মূল্য ধরা)'
);
