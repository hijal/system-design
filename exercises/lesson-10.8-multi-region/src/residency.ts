import { env, heading, n, row, tb, usd } from './util';

const EU_WORKSPACES = env('EU_WORKSPACES', 300);
const EU_SEATS = env('EU_SEATS', 6_000);
const EU_PAID_SEATS = env('EU_PAID_SEATS', 4_200);
const SEAT_PRICE = env('SEAT_PRICE', 9);

type Where = 'eu' | 'out';
type Design = 'single' | 'partial' | 'cell';
type Flow = {
	name: string;
	gbPerMonth: number;
	personal: string;
	where: Record<Design, Where>;
	fix: string;
};

const FLOWS: Flow[] = [
	{
		name: 'Postgres (primary + replica)',
		gbPerMonth: 80,
		personal: 'name, email, tasks',
		where: { single: 'out', partial: 'eu', cell: 'eu' },
		fix: "the EU cell's own DB"
	},
	{
		name: 'attachment (S3)',
		gbPerMonth: 3_000,
		personal: 'file',
		where: { single: 'out', partial: 'eu', cell: 'eu' },
		fix: 'EU bucket'
	},
	{
		name: 'DR copy: backups and replicas',
		gbPerMonth: 3_100,
		personal: 'everything',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'DR in a second EU region'
	},
	{
		name: 'CDN edge cache',
		gbPerMonth: 600,
		personal: 'file',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'no private file cache / EU edge'
	},
	{
		name: 'logs (central log store)',
		gbPerMonth: 45,
		personal: 'user id, IP',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: "the cell's own log store"
	},
	{
		name: 'trace',
		gbPerMonth: 15,
		personal: 'user id, workspace',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: "the cell's own collector"
	},
	{
		name: 'metric',
		gbPerMonth: 2,
		personal: 'none (clean labels)',
		where: { single: 'out', partial: 'out', cell: 'out' },
		fix: 'no personal data - fine outside'
	},
	{
		name: 'search index (8.3)',
		gbPerMonth: 40,
		personal: 'task text',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'an index per cell'
	},
	{
		name: 'analytics warehouse (7.6)',
		gbPerMonth: 60,
		personal: 'event, user id',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'user-level events in the cell; only aggregates outside'
	},
	{
		name: 'analytics: aggregates only (no user id)',
		gbPerMonth: 1,
		personal: 'none (counts by day × plan × feature)',
		where: { single: 'out', partial: 'out', cell: 'out' },
		fix: 'no personal data - fine outside'
	},
	{
		name: 'identity: user email and profile',
		gbPerMonth: 1,
		personal: 'email, name',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'profile in the EU; only hash → region globally'
	},
	{
		name: 'email provider',
		gbPerMonth: 5,
		personal: 'email, name, task titles',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: "the provider's EU processing"
	},
	{
		name: 'error tracker (with request bodies)',
		gbPerMonth: 3,
		personal: 'whatever is in the body',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'EU instance + scrubbing'
	}
];

const DESIGNS: [Design, string][] = [
	['single', 'all in Singapore'],
	['partial', 'DB + app + S3 in the EU'],
	['cell', 'a full EU cell']
];

heading(
	`Part A - one EU customer's ${n(EU_WORKSPACES)} workspaces, ${n(EU_SEATS)} users: where their data goes`
);
console.log(
	row([
		['path', 44],
		['GB/month', 10],
		['personal data', 40],
		...DESIGNS.map(([, name]): [string, number] => [name, 20])
	])
);
for (const f of FLOWS) {
	console.log(
		row([
			[f.name, 44],
			[n(f.gbPerMonth), 10],
			[`  ${f.personal}`, 40],
			...DESIGNS.map(([d]): [string, number] => [
				f.where[d] === 'eu' ? 'in the EU' : 'outside ✗',
				20
			])
		])
	);
}
const personalFlows = FLOWS.filter((f) => !f.personal.startsWith('none'));
console.log(
	row([
		['paths taking personal data outside', 44],
		['', 9],
		['', 40],
		...DESIGNS.map(([d]): [string, number] => [
			`${personalFlows.filter((f) => f.where[d] === 'out').length} / ${personalFlows.length}`,
			20
		])
	])
);
console.log(
	row([
		['personal data going outside / month', 44],
		['', 9],
		['', 40],
		...DESIGNS.map(([d]): [string, number] => [
			tb(personalFlows.filter((f) => f.where[d] === 'out').reduce((s, f) => s + f.gbPerMonth, 0)),
			20
		])
	])
);
console.log('\nhow to fix what remains with "partial":');
for (const f of personalFlows.filter((x) => x.where.partial === 'out'))
	console.log(`  ${f.name} → ${f.fix}`);

heading("Part B - the cost of one cell vs this customer's revenue");
const H = 730;
const CELL: [string, number][] = [
	['app (min 3, commit)', 3 * 0.192 * H * 0.65],
	['Postgres Multi-AZ + 1 replica', 3 * 1.0 * H * 0.65 + 900 * 0.115 * 0.2],
	['Redis (cache + queue)', 2 * 0.2 * H * 0.65],
	['NAT ×3 + LB + endpoint', 3 * 0.045 * H + 100 + 22],
	["log/trace/metric stack (the cell's own)", 450],
	['DR: pilot light in a second EU region', 0.65 * 1.0 * H + 3_000 * 0.0125],
	["search (the cell's own)", 2 * 0.192 * H],
	['average people time (on-call, upgrades × 2 cells)', 1_500]
];
let cellTotal = 0;
for (const [name, cost] of CELL) {
	cellTotal += cost;
	console.log(
		row([
			[name, 54],
			[usd(cost), 12]
		])
	);
}
const revenue = EU_PAID_SEATS * SEAT_PRICE;
console.log(
	row([
		['cell total / month', 54],
		[usd(cellTotal), 12]
	])
);
console.log(
	row([
		[`this customer's revenue (${n(EU_PAID_SEATS)} paid seats × $${SEAT_PRICE})`, 54],
		[usd(revenue), 12]
	])
);
console.log(
	row([
		["the cell's cost as % of revenue", 54],
		[`${((cellTotal / revenue) * 100).toFixed(0)}%`, 12]
	])
);
console.log(
	'\n(a cell has a fixed base cost whatever the number of users; it gets shared with the second and third EU customers)'
);
