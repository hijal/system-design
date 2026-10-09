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
	`Part A - one week: average ${AVG_RPS} req/s, peak ${n(peak)} req/s (marketing email at 10 on Wednesday), ${PER_INSTANCE} req/s per instance, ${BOOT_MINUTES} minutes to start`
);
console.log(
	row([
		['policy', 40],
		['avg instances', 15],
		['cost / month', 14],
		['avg use', 12],
		['strained min', 14],
		['overflowing req', 17],
		['overflow in spike', 19],
		['spot lost', 11]
	])
);
const results = new Map<Policy['kind'], Result>();
for (const policy of POLICIES) {
	const r = simulate(policy);
	results.set(policy.kind, r);
	console.log(
		row([
			[policy.name, 40],
			[(r.instanceMinutes / WEEK).toFixed(1), 15],
			[usd(monthly(r.cost)), 14],
			[pct(r.utilization, 1, 0), 12],
			[n(r.overloadedMinutes), 14],
			[`${n(r.excessRequests)} (${pct(r.excessRequests, weekRequests, 2)})`, 16],
			[n(r.spikeExcess), 19],
			[n(r.interruptions), 11]
		])
	);
}
console.log(
	'\n("overflowing req" = requests above capacity in that minute - slow, queued, or 503; "in spike" = the 3 hours on Wednesday)'
);

const reactive = results.get('reactive');
if (reactive) {
	const usage = reactive.hourly;
	const maxUse = Math.ceil(Math.max(...usage));
	heading(
		`Part B - commitment (savings plan / reserved): on reactive's hourly usage, ${Math.round(P.commitDiscount * 100)}% discount`
	);
	console.log(
		row([
			['commit (instance)', 18],
			['cost / month', 14],
			['vs on-demand', 20],
			['% of hours with use ≥ commit', 30],
			['unused commit', 16]
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
				[`${c}${c === best ? '  ← lowest' : ''}`, 18],
				[usd(cost), 14],
				[pct(base - cost, base, 1), 20],
				[pct(covered, 1, 0), 30],
				[usd(wasted), 16]
			])
		);
	}
	console.log(
		`\n(rule: one more unit of commit pays off as long as usage stays above it > ${Math.round((1 - P.commitDiscount) * 100)}% of the hours - i.e. the complement of the discount)`
	);
}

heading(
	"Part C - 10.5's L7 flood: 60,000 req/s, 4 hours, 30 KB per answer - what the bill is depending on where it is stopped"
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
		name: 'autoscale at the origin, no limit',
		instances: Math.ceil(FLOOD_RPS / (PER_INSTANCE * TARGET)),
		egressGb: (floodRequests * 30) / 1e6,
		egressPrice: P.internetEgressGb,
		cdnRequests: 0
	},
	{
		name: 'autoscale at the origin, limit 40',
		instances: 40,
		egressGb: (40 * PER_INSTANCE * FLOOD_SECONDS * 30) / 1e6,
		egressPrice: P.internetEgressGb,
		cdnRequests: 0
	},
	{
		name: 'answered from CDN cache (cache key fixed)',
		instances: 0,
		egressGb: (floodRequests * 30) / 1e6,
		egressPrice: P.cdnEgressGb,
		cdnRequests: floodRequests
	},
	{
		name: 'block / challenge at the edge (1 KB answer)',
		instances: 0,
		egressGb: (floodRequests * 1) / 1e6,
		egressPrice: P.cdnEgressGb,
		cdnRequests: floodRequests
	}
];
console.log(
	row([
		['where it stopped', 46],
		['extra instances', 17],
		['compute', 10],
		['data transfer', 14],
		['request fees', 15],
		['total', 10]
	])
);
for (const s of STOPS) {
	const compute = s.instances * P.appInstanceHour * (FLOOD_SECONDS / 3_600);
	const transfer = s.egressGb * s.egressPrice;
	const fees = (s.cdnRequests / 10_000) * P.cdnPer10kRequests;
	console.log(
		row([
			[s.name, 46],
			[n(s.instances), 17],
			[usd(compute), 10],
			[usd(transfer), 14],
			[usd(fees), 15],
			[usd(compute + transfer + fees), 10]
		])
	);
}
console.log(
	'\n(many CDNs/providers waive or separate the bill for DDoS traffic - check their terms; list prices are assumed here)'
);
