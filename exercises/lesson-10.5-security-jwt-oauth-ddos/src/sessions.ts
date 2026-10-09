import { duration, exponential, heading, lognormal, mulberry32, n, pct, row } from './util';

const SESSIONS = Number(process.env.SESSIONS ?? 60_000);
const RPS = Number(process.env.RPS ?? 300);
const HOURS = Number(process.env.HOURS ?? 8);
const REVOCATIONS = Number(process.env.REVOCATIONS ?? 2_000);
const PUSH_SECONDS = Number(process.env.PUSH_SECONDS ?? 5);
const SEED = Number(process.env.SEED ?? 510);

type Policy =
	| { kind: 'stateless'; name: string; ttl: number }
	| { kind: 'lookup'; name: string }
	| { kind: 'refresh'; name: string; ttl: number }
	| { kind: 'denylist'; name: string; ttl: number };

const POLICIES: Policy[] = [
	{ kind: 'stateless', name: 'JWT 24 h, no revoke', ttl: 86_400 },
	{ kind: 'lookup', name: 'session lookup on every request' },
	{ kind: 'refresh', name: 'access 1 h + refresh', ttl: 3_600 },
	{ kind: 'refresh', name: 'access 15 min + refresh', ttl: 900 },
	{ kind: 'refresh', name: 'access 5 min + refresh', ttl: 300 },
	{ kind: 'denylist', name: 'access 15 min + refresh + denylist', ttl: 900 }
];

const SPAN = HOURS * 3_600;
const random = mulberry32(SEED);
const meanRate = RPS / SESSIONS;
const rawRates = Array.from({ length: SESSIONS }, () => lognormal(random, 1, 1.2));
const rawMean = rawRates.reduce((a, b) => a + b, 0) / SESSIONS;
const timelines: Float64Array[] = rawRates.map((raw) => {
	const rate = (raw / rawMean) * meanRate;
	const times: number[] = [];
	let t = exponential(random, 1 / rate);
	while (t < SPAN) {
		times.push(t);
		t += exponential(random, 1 / rate);
	}
	return Float64Array.from(times);
});
const totalRequests = timelines.reduce((sum, t) => sum + t.length, 0);

function issueTimes(times: Float64Array, ttl: number): number[] {
	const issued: number[] = [];
	let expires = -Infinity;
	for (const t of times) {
		if (t >= expires) {
			issued.push(t);
			expires = t + ttl;
		}
	}
	return issued;
}

const revokeRandom = mulberry32(SEED + 7);
const revokes = Array.from({ length: REVOCATIONS }, () => ({
	session: Math.floor(revokeRandom() * SESSIONS),
	at: 3_600 + revokeRandom() * (SPAN - 3_600)
}));

function liveAfterRevoke(policy: Policy, session: number, at: number): number {
	if (policy.kind === 'lookup') return 0;
	if (policy.kind === 'denylist') return PUSH_SECONDS;
	const times = timelines[session];
	if (!times) return 0;
	let last = -Infinity;
	for (const issued of issueTimes(times, policy.ttl)) {
		if (issued > at) break;
		last = issued;
	}
	if (policy.kind === 'stateless' && last === -Infinity) last = at - revokeRandom() * policy.ttl;
	return Math.max(0, last + policy.ttl - at);
}

heading(
	`Part A - ${n(SESSIONS)} active sessions, ${RPS} req/s, ${HOURS} hours (${n(totalRequests)} requests)`
);
console.log(
	row([
		['policy', 36],
		['store/identity call/s', 22],
		['% of requests', 14],
		['after revoke: avg', 20],
		['worst', 14],
		['works if identity dies', 24]
	])
);
for (const policy of POLICIES) {
	let calls = 0;
	if (policy.kind === 'lookup') calls = totalRequests;
	else if (policy.kind === 'refresh' || policy.kind === 'denylist')
		for (const t of timelines) calls += issueTimes(t, policy.ttl).length;
	const lags = revokes.map((r) => liveAfterRevoke(policy, r.session, r.at));
	const mean = lags.reduce((a, b) => a + b, 0) / lags.length;
	const worst =
		policy.kind === 'lookup' ? 0 : policy.kind === 'denylist' ? PUSH_SECONDS : policy.ttl;
	const outage = policy.kind === 'lookup' ? 0 : policy.ttl;
	console.log(
		row([
			[policy.name, 36],
			[(calls / SPAN).toFixed(1), 22],
			[pct(calls, totalRequests), 14],
			[duration(mean / 60), 20],
			[duration(worst / 60), 14],
			[duration(outage / 60), 18]
		])
	);
}
console.log(
	'\n(denylist\'s "works if identity dies": it runs on the last denylist received; new revokes don\'t arrive meanwhile)'
);

type Family = { id: number; current: string; used: Set<string>; revoked: boolean; created: number };
type Mode = { name: string; rotate: boolean; detectReuse: boolean };

class RefreshStore {
	readonly #families = new Map<number, Family>();
	readonly #byToken = new Map<string, number>();
	#next = 1;
	reuseAlerts = 0;
	constructor(
		readonly mode: Mode,
		readonly maxAgeMinutes: number
	) {}
	login(now: number): string {
		const id = this.#next++;
		const token = `rt-${id}-0`;
		this.#families.set(id, { id, current: token, used: new Set(), revoked: false, created: now });
		this.#byToken.set(token, id);
		return token;
	}
	refresh(token: string, now: number): string | null {
		const id = this.#byToken.get(token);
		const family = id === undefined ? undefined : this.#families.get(id);
		if (!family || family.revoked || now - family.created > this.maxAgeMinutes) return null;
		if (!this.mode.rotate) return token;
		if (family.current !== token) {
			if (this.mode.detectReuse && family.used.has(token)) {
				family.revoked = true;
				this.reuseAlerts++;
			}
			return null;
		}
		family.used.add(token);
		const next = `rt-${family.id}-${family.used.size}`;
		family.current = next;
		this.#byToken.set(next, family.id);
		return next;
	}
}

type Actor = { access: number; refresh: string | null };
type Scenario = { name: string; theftAt: number; aliceActive: (minute: number) => boolean };

const ACCESS_MINUTES = 15;
const REFRESH_DAYS = 30;
const DAY = 1_440;
const workHours = (minute: number): boolean => {
	const day = Math.floor(minute / DAY) % 7;
	const hour = (minute % DAY) / 60;
	return day < 5 && hour >= 9 && hour < 17 && minute % 5 === 0;
};
const SCENARIOS: Scenario[] = [
	{ name: 'stolen Monday 10:00, alice at work', theftAt: 10 * 60, aliceActive: workHours },
	{
		name: 'stolen Friday 16:50, alice back Monday',
		theftAt: 4 * DAY + 16 * 60 + 50,
		aliceActive: workHours
	}
];
const MODES: Mode[] = [
	{ name: 'no rotation', rotate: false, detectReuse: false },
	{ name: 'rotation, no reuse detection', rotate: true, detectReuse: false },
	{ name: 'rotation + reuse detection', rotate: true, detectReuse: true }
];

function run(
	mode: Mode,
	scenario: Scenario
): { attackerMinutes: number; lastAccess: number; aliceLogins: number; alerts: number } {
	const store = new RefreshStore(mode, REFRESH_DAYS * DAY);
	const alice: Actor = { access: -1, refresh: store.login(0) };
	const attacker: Actor = { access: -1, refresh: null };
	let aliceLogins = 1;
	let attackerMinutes = 0;
	let lastAccess = -1;
	const use = (actor: Actor, now: number): boolean => {
		if (now < actor.access) return true;
		if (actor.refresh === null) return false;
		const next = store.refresh(actor.refresh, now);
		if (next === null) {
			actor.refresh = null;
			return false;
		}
		actor.refresh = next;
		actor.access = now + ACCESS_MINUTES;
		return true;
	};
	for (let minute = 0; minute < REFRESH_DAYS * DAY; minute++) {
		if (scenario.aliceActive(minute) && !use(alice, minute)) {
			alice.refresh = store.login(minute);
			alice.access = minute + ACCESS_MINUTES;
			aliceLogins++;
		}
		if (minute === scenario.theftAt) attacker.refresh = alice.refresh;
		if (minute >= scenario.theftAt + 10 && use(attacker, minute)) {
			attackerMinutes++;
			lastAccess = minute;
		}
	}
	return { attackerMinutes, lastAccess, aliceLogins, alerts: store.reuseAlerts };
}

heading(
	`Part B - refresh token theft (access ${ACCESS_MINUTES} min, refresh ${REFRESH_DAYS} days), the attacker starts 10 minutes later`
);
for (const scenario of SCENARIOS) {
	console.log(`\n${scenario.name}`);
	console.log(
		row([
			['policy', 34],
			['attacker holds it', 19],
			['alice forced to log out', 25],
			['security alert', 16]
		])
	);
	for (const mode of MODES) {
		const result = run(mode, scenario);
		const window = result.lastAccess < 0 ? 0 : result.lastAccess - (scenario.theftAt + 10) + 1;
		console.log(
			row([
				[mode.name, 34],
				[duration(window), 19],
				[n(result.aliceLogins - 1), 25],
				[n(result.alerts), 16]
			])
		);
	}
}
