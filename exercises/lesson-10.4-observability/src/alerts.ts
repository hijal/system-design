import { heading, mulberry32, n, pct, row } from './random';

const RPS = Number(process.env.RPS ?? 300);
const SLO = Number(process.env.SLO ?? 0.999);
const BASE_ERROR = Number(process.env.BASE_ERROR ?? 0.0002);
const DEPLOY_BLIP = Number(process.env.DEPLOY_BLIP ?? 0.03);
const DAYS = 7;
const INCIDENT_AT = 3 * 1_440 + 9 * 60;
const SEED = Number(process.env.SEED ?? 29);

const PER_MINUTE = RPS * 60;
const BUDGET_RATIO = 1 - SLO;
const MONTH_BUDGET = BUDGET_RATIO * PER_MINUTE * 1_440 * 30;
const MINUTES = DAYS * 1_440;

type Incident = { name: string; minutes: number; rate: number };

const SCENARIOS: Incident[] = [
	{ name: 'big outage: 30 minutes, 20%', minutes: 30, rate: 0.2 },
	{ name: 'medium: 2 hours, 1.5%', minutes: 120, rate: 0.015 },
	{ name: 'slow burn: 3 days, 0.4%', minutes: 3 * 1_440, rate: 0.004 },
	{ name: 'short blip: 3 minutes, 30%', minutes: 3, rate: 0.3 },
	{ name: 'nothing (only the deploy blip)', minutes: 0, rate: 0 }
];

type Window = (errors: Float64Array, requests: number, end: number, minutes: number) => number;

const errorRatio: Window = (errors, _requests, end, minutes) => {
	const start = Math.max(0, end - minutes);
	return ((errors[end] ?? 0) - (errors[start] ?? 0)) / ((end - start) * PER_MINUTE);
};

const burn = (errors: Float64Array, end: number, minutes: number): number =>
	errorRatio(errors, PER_MINUTE, end, minutes) / BUDGET_RATIO;

type Policy = {
	name: string;
	page: (errors: Float64Array, t: number) => boolean;
	ticket?: (errors: Float64Array, t: number) => boolean;
};

const POLICIES: Policy[] = [
	{ name: 'error > 1%, 5 min', page: (e, t) => errorRatio(e, PER_MINUTE, t, 5) > 0.01 },
	{
		name: `error > ${+(BUDGET_RATIO * 100).toFixed(3)}%, 5 min`,
		page: (e, t) => errorRatio(e, PER_MINUTE, t, 5) > BUDGET_RATIO
	},
	{ name: 'burn > 14.4, 1 h', page: (e, t) => burn(e, t, 60) > 14.4 },
	{
		name: 'multi-window',
		page: (e, t) =>
			(burn(e, t, 60) > 14.4 && burn(e, t, 5) > 14.4) ||
			(burn(e, t, 360) > 6 && burn(e, t, 30) > 6),
		ticket: (e, t) => burn(e, t, 3 * 1_440) > 1 && burn(e, t, 360) > 1
	}
];

function binomial(random: () => number, trials: number, p: number): number {
	const mean = trials * p;
	if (mean < 30) {
		let count = 0;
		let product = random();
		const limit = Math.exp(-mean);
		while (product > limit) {
			count++;
			product *= random();
		}
		return count;
	}
	const u = 1 - random();
	const v = random();
	const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	return Math.max(0, Math.round(mean + normal * Math.sqrt(mean * (1 - p))));
}

function timeline(incident: Incident): { cumulative: Float64Array; incidentErrors: number } {
	const random = mulberry32(SEED);
	const cumulative = new Float64Array(MINUTES + 1);
	let incidentErrors = 0;
	for (let m = 0; m < MINUTES; m++) {
		const minuteOfDay = m % 1_440;
		let rate = BASE_ERROR;
		if (minuteOfDay >= 14 * 60 && minuteOfDay < 14 * 60 + 2) rate = DEPLOY_BLIP;
		const inIncident = m >= INCIDENT_AT && m < INCIDENT_AT + incident.minutes;
		if (inIncident) rate = Math.max(rate, incident.rate);
		const errors = binomial(random, PER_MINUTE, rate);
		if (inIncident) incidentErrors += errors - PER_MINUTE * BASE_ERROR;
		cumulative[m + 1] = (cumulative[m] ?? 0) + errors;
	}
	return { cumulative, incidentErrors };
}

type Outcome = {
	firstPage: number | null;
	firstTicket: number | null;
	pages: number;
	tickets: number;
	budgetAtPage: number;
};

function evaluate(policy: Policy, cumulative: Float64Array, baseline: Float64Array): Outcome {
	let pages = 0;
	let tickets = 0;
	let firstPage: number | null = null;
	let firstTicket: number | null = null;
	let paging = false;
	let ticketing = false;
	for (let t = 1; t <= MINUTES; t++) {
		const page = policy.page(cumulative, t);
		if (page && !paging) pages++;
		if (page && firstPage === null && t > INCIDENT_AT && !policy.page(baseline, t)) firstPage = t;
		paging = page;
		const ticket = policy.ticket?.(cumulative, t) ?? false;
		if (ticket && !ticketing) tickets++;
		if (ticket && firstTicket === null && t > INCIDENT_AT && !policy.ticket?.(baseline, t))
			firstTicket = t;
		ticketing = ticket;
	}
	const at = firstPage ?? firstTicket;
	const budgetAtPage =
		at === null
			? 0
			: ((cumulative[at] ?? 0) -
					(cumulative[INCIDENT_AT] ?? 0) -
					(at - INCIDENT_AT) * PER_MINUTE * BASE_ERROR) /
				MONTH_BUDGET;
	return { firstPage, firstTicket, pages, tickets, budgetAtPage };
}

const after = (t: number | null): string => {
	if (t === null) return '—';
	const minutes = t - INCIDENT_AT;
	return minutes >= 120 ? `${(minutes / 60).toFixed(1)} h` : `${minutes} min`;
};

heading(
	`A. SLO ${SLO * 100}% (error budget of ${n(MONTH_BUDGET)} failed requests in 30 days), ${RPS} req/s; the event starts at 9 am on day 4 — who paged, and when`
);
console.log(
	row([
		['event', 34],
		['budget used', 12],
		...POLICIES.map((policy): [string, number] => [policy.name, 20])
	])
);
const baseline = timeline({ name: '', minutes: 0, rate: 0 }).cumulative;
const results = SCENARIOS.map((scenario) => {
	const { cumulative, incidentErrors } = timeline(scenario);
	return {
		scenario,
		incidentErrors,
		outcomes: POLICIES.map((policy) => evaluate(policy, cumulative, baseline))
	};
});
for (const { scenario, incidentErrors, outcomes } of results) {
	if (scenario.minutes === 0) continue;
	console.log(
		row([
			[scenario.name, 34],
			[pct(incidentErrors, MONTH_BUDGET, 1), 12],
			...outcomes.map((outcome): [string, number] => {
				if (outcome.firstPage !== null)
					return [`${after(outcome.firstPage)} (${pct(outcome.budgetAtPage, 1, 1)})`, 20];
				if (outcome.firstTicket !== null)
					return [`ticket ${after(outcome.firstTicket)} (${pct(outcome.budgetAtPage, 1, 1)})`, 20];
				return ['missed', 20];
			})
		])
	);
}
console.log(
	'   "when" = how long after the event started came the first page that would not have fired without the event (coincidental pages from the deploy blip excluded); in brackets, what % of the month\'s budget the event had used by then'
);

heading(
	`B. Total pages in ${DAYS} days (a deploy at 2 pm every day, 2 minutes of ${DEPLOY_BLIP * 100}% errors)`
);
console.log(row([['event', 34], ...POLICIES.map((policy): [string, number] => [policy.name, 20])]));
for (const { scenario, outcomes } of results) {
	console.log(
		row([
			[scenario.name, 34],
			...outcomes.map((outcome): [string, number] => [
				outcome.tickets > 0 ? `${outcome.pages} (+${outcome.tickets} ticket)` : `${outcome.pages}`,
				20
			])
		])
	);
}
