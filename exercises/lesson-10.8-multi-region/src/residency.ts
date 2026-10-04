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
		personal: 'নাম, email, task',
		where: { single: 'out', partial: 'eu', cell: 'eu' },
		fix: 'EU cell এর নিজের DB'
	},
	{
		name: 'attachment (S3)',
		gbPerMonth: 3_000,
		personal: 'file',
		where: { single: 'out', partial: 'eu', cell: 'eu' },
		fix: 'EU bucket'
	},
	{
		name: 'DR copy: backup আর replica',
		gbPerMonth: 3_100,
		personal: 'সব',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'দ্বিতীয় EU region এ DR'
	},
	{
		name: 'CDN edge cache',
		gbPerMonth: 600,
		personal: 'file',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'private file cache না / EU edge'
	},
	{
		name: 'log (কেন্দ্রীয় log store)',
		gbPerMonth: 45,
		personal: 'user id, IP',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'cell এর নিজের log store'
	},
	{
		name: 'trace',
		gbPerMonth: 15,
		personal: 'user id, workspace',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'cell এর নিজের collector'
	},
	{
		name: 'metric',
		gbPerMonth: 2,
		personal: 'নেই (label পরিষ্কার)',
		where: { single: 'out', partial: 'out', cell: 'out' },
		fix: 'ব্যক্তিগত data নেই — বাইরে ঠিক আছে'
	},
	{
		name: 'search index (8.3)',
		gbPerMonth: 40,
		personal: 'task এর লেখা',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'cell ধরে index'
	},
	{
		name: 'analytics warehouse (7.6)',
		gbPerMonth: 60,
		personal: 'event, user id',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'user স্তরের event cell এ; বাইরে শুধু aggregate'
	},
	{
		name: 'analytics: শুধু aggregate (user id নেই)',
		gbPerMonth: 1,
		personal: 'নেই (দিন × plan × feature এর গণনা)',
		where: { single: 'out', partial: 'out', cell: 'out' },
		fix: 'ব্যক্তিগত data নেই — বাইরে ঠিক আছে'
	},
	{
		name: 'identity: user এর email আর profile',
		gbPerMonth: 1,
		personal: 'email, নাম',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'profile EU তে; global এ শুধু hash → region'
	},
	{
		name: 'email provider',
		gbPerMonth: 5,
		personal: 'email, নাম, task এর শিরোনাম',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'provider এর EU processing'
	},
	{
		name: 'error tracker (request body সহ)',
		gbPerMonth: 3,
		personal: 'যা কিছু body তে',
		where: { single: 'out', partial: 'out', cell: 'eu' },
		fix: 'EU instance + scrubbing'
	}
];

const DESIGNS: [Design, string][] = [
	['single', 'সব সিঙ্গাপুরে'],
	['partial', 'EU এ DB + app + S3'],
	['cell', 'পুরো EU cell']
];

heading(
	`অংশ ক — একজন EU customer এর ${n(EU_WORKSPACES)} workspace, ${n(EU_SEATS)} user: তাদের data কোথায় কোথায় যায়`
);
console.log(
	row([
		['পথ', 36],
		['GB/মাস', 9],
		['ব্যক্তিগত data', 26],
		...DESIGNS.map(([, name]): [string, number] => [name, 20])
	])
);
for (const f of FLOWS) {
	console.log(
		row([
			[f.name, 36],
			[n(f.gbPerMonth), 9],
			[`  ${f.personal}`, 26],
			...DESIGNS.map(([d]): [string, number] => [f.where[d] === 'eu' ? 'EU তে' : 'বাইরে ✗', 20])
		])
	);
}
const personalFlows = FLOWS.filter((f) => !f.personal.startsWith('নেই'));
console.log(
	row([
		['ব্যক্তিগত data বাইরে যায় এমন পথ', 36],
		['', 9],
		['', 26],
		...DESIGNS.map(([d]): [string, number] => [
			`${personalFlows.filter((f) => f.where[d] === 'out').length} / ${personalFlows.length}`,
			20
		])
	])
);
console.log(
	row([
		['বাইরে যাওয়া ব্যক্তিগত data / মাস', 36],
		['', 9],
		['', 26],
		...DESIGNS.map(([d]): [string, number] => [
			tb(personalFlows.filter((f) => f.where[d] === 'out').reduce((s, f) => s + f.gbPerMonth, 0)),
			20
		])
	])
);
console.log('\n"partial" এ যা থেকে যায়, তার ঠিক করার পথ:');
for (const f of personalFlows.filter((x) => x.where.partial === 'out'))
	console.log(`  ${f.name} → ${f.fix}`);

heading('অংশ খ — একটা cell এর দাম বনাম এই customer এর আয়');
const H = 730;
const CELL: [string, number][] = [
	['app (min ৩, commit)', 3 * 0.192 * H * 0.65],
	['Postgres Multi-AZ + ১ replica', 3 * 1.0 * H * 0.65 + 900 * 0.115 * 0.2],
	['Redis (cache + queue)', 2 * 0.2 * H * 0.65],
	['NAT ×৩ + LB + endpoint', 3 * 0.045 * H + 100 + 22],
	['log/trace/metric stack (cell এর নিজের)', 450],
	['DR: দ্বিতীয় EU region এ pilot light', 0.65 * 1.0 * H + 3_000 * 0.0125],
	['search (cell এর নিজের)', 2 * 0.192 * H],
	['গড়ে মানুষের সময় (on-call, upgrade × ২ cell)', 1_500]
];
let cellTotal = 0;
for (const [name, cost] of CELL) {
	cellTotal += cost;
	console.log(
		row([
			[name, 46],
			[usd(cost), 12]
		])
	);
}
const revenue = EU_PAID_SEATS * SEAT_PRICE;
console.log(
	row([
		['cell এর মোট / মাস', 46],
		[usd(cellTotal), 12]
	])
);
console.log(
	row([
		[`এই customer এর আয় (${n(EU_PAID_SEATS)} paid seat × $${SEAT_PRICE})`, 46],
		[usd(revenue), 12]
	])
);
console.log(
	row([
		['cell এর দাম আয়ের %', 46],
		[`${((cellTotal / revenue) * 100).toFixed(0)}%`, 12]
	])
);
console.log(
	'\n(cell এর একটা স্থির ভিত্তি খরচ আছে, user এর সংখ্যা যা-ই হোক; দ্বিতীয়, তৃতীয় EU customer এ ভাগ হয়ে যায়)'
);
