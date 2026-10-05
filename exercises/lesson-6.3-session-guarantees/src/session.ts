import { mulberry32 } from './random';
import { Replica, shuffled, type LagModel } from './replica';

// Lesson 6.3 §1.3–1.4 — one primary, three async replicas, and five kinds of read routing.
//
// A busy TaskFlow workspace: the whole team together makes ~200 writes a second (tasks, comments, statuses).
// Every write gets an LSN on the primary (Lesson 5.7), and every replica receives it at its own lag —
// in order (when one stalls, everything behind it stalls).
//
// 400 users, each with two devices (phone, laptop). 2000 times a user creates a task, then
// reads: on the redirect (+5 ms), then at +30 ms, +300 ms, +1 s, +3 s. The first two reads are on the same device,
// half of the rest on the other device.
//
// Two questions on every read:
//   read-your-writes — is the user's own last write in this read? (same device / other device counted separately)
//   monotonic read   — is this read **older** than one of the user's earlier reads? (time went backwards)

const SIM_MS = 120_000;
const BACKGROUND_WRITES_PER_S = 200;
const USERS = 400;
const SESSIONS = 2000;
const READ_OFFSETS_MS = [5, 30, 300, 1000, 3000];

const REPLICAS: LagModel[] = [
	{ base: 1, mean: 2, stallPerWrite: 0, stallMs: 0 }, // r1 — fast, never stalls
	{ base: 3, mean: 8, stallPerWrite: 0.00005, stallMs: 1500 }, // r2
	{ base: 5, mean: 20, stallPerWrite: 0.0002, stallMs: 3000 } // r3 — slow, stalls for a few seconds now and then
];

type Strategy = 'random' | 'sticky' | 'cookie' | 'token-device' | 'token-user';

type Action =
	| { kind: 'background'; at: number }
	| { kind: 'write'; at: number; user: number; device: string; session: number }
	| { kind: 'read'; at: number; user: number; device: string; session: number; writer: string };

function workload(): Action[] {
	const random = mulberry32(63);
	const actions: Action[] = [];
	for (let t = 0; t < SIM_MS;) {
		t += -Math.log(1 - random()) * (1000 / BACKGROUND_WRITES_PER_S);
		actions.push({ kind: 'background', at: t });
	}
	for (let s = 0; s < SESSIONS; s++) {
		const user = Math.floor(random() * USERS);
		const start = 1000 + random() * (SIM_MS - 10_000);
		const writer = `${user}:${random() < 0.5 ? 'phone' : 'laptop'}`;
		actions.push({ kind: 'write', at: start, user, device: writer, session: s });
		READ_OFFSETS_MS.forEach((offset, i) => {
			const other = writer.endsWith('phone') ? `${user}:laptop` : `${user}:phone`;
			const device = i < 2 || random() < 0.5 ? writer : other;
			actions.push({ kind: 'read', at: start + offset, user, device, session: s, writer });
		});
	}
	return actions.sort((a, b) => a.at - b.at);
}

type Result = {
	sameDeviceReads: number;
	sameDeviceMissed: number;
	otherDeviceReads: number;
	otherDeviceMissed: number;
	reads: number;
	wentBack: number;
	onPrimary: number;
};

function run(strategy: Strategy, actions: Action[]): Result {
	const lagRandom = mulberry32(64); // exactly the same lag for every strategy
	const routeRandom = mulberry32(65);
	const replicas = REPLICAS.map((model) => new Replica(model, lagRandom));
	let lsn = 0;

	const lastWriteAt = new Map<string, number>(); // device → time of the last write (cookie)
	const sessionWrite = new Map<number, number>(); // session → the LSN of that session's write
	const userLastSeen = new Map<number, number>(); // user → the newest LSN of the earlier reads
	const token = new Map<string, number>(); // device or user → the newest LSN seen/written

	const result: Result = {
		sameDeviceReads: 0,
		sameDeviceMissed: 0,
		otherDeviceReads: 0,
		otherDeviceMissed: 0,
		reads: 0,
		wentBack: 0,
		onPrimary: 0
	};

	function replayed(r: number, at: number): number {
		return replicas[r]?.replayedAt(at) ?? 0;
	}

	function commit(at: number): number {
		lsn += 1;
		for (const replica of replicas) replica.receive(at);
		return lsn;
	}

	function route(user: number, device: string, at: number): number {
		const order = shuffled([0, 1, 2], routeRandom);
		switch (strategy) {
			case 'random':
				return replayed(order[0] ?? 0, at);
			case 'sticky': {
				let h = 0;
				for (const ch of device) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
				return replayed(h % REPLICAS.length, at);
			}
			case 'cookie':
				// Lesson 5.7's fix: if this device wrote in the last 5 seconds, from the primary
				if (at - (lastWriteAt.get(device) ?? -Infinity) < 5000) {
					result.onPrimary++;
					return lsn;
				}
				return replayed(order[0] ?? 0, at);
			case 'token-device':
			case 'token-user': {
				const key = strategy === 'token-user' ? `u${user}` : device;
				const need = token.get(key) ?? 0;
				for (const r of order) {
					const seen = replayed(r, at);
					if (seen >= need) return seen; // this replica is far enough ahead
				}
				result.onPrimary++; // no replica is ahead → primary
				return lsn;
			}
		}
	}

	for (const action of actions) {
		if (action.kind === 'background') {
			commit(action.at);
			continue;
		}
		if (action.kind === 'write') {
			const written = commit(action.at);
			lastWriteAt.set(action.device, action.at);
			sessionWrite.set(action.session, written);
			token.set(action.device, written);
			token.set(`u${action.user}`, written);
			continue;
		}
		const seen = route(action.user, action.device, action.at);
		result.reads++;
		const mine = sessionWrite.get(action.session) ?? 0; // what the user wrote themselves in this session
		if (action.device === action.writer) {
			result.sameDeviceReads++;
			if (seen < mine) result.sameDeviceMissed++;
		} else {
			result.otherDeviceReads++;
			if (seen < mine) result.otherDeviceMissed++;
		}
		if (seen < (userLastSeen.get(action.user) ?? 0)) result.wentBack++;
		userLastSeen.set(action.user, Math.max(userLastSeen.get(action.user) ?? 0, seen));
		token.set(action.device, Math.max(token.get(action.device) ?? 0, seen));
		token.set(`u${action.user}`, Math.max(token.get(`u${action.user}`) ?? 0, seen));
	}
	return result;
}

function pct(part: number, whole: number): string {
	return `${((part / Math.max(1, whole)) * 100).toFixed(1).padStart(5)}%`;
}

function main(): void {
	const actions = workload();
	const labels: Record<Strategy, string> = {
		random: 'A. any replica (random)',
		sticky: 'B. one fixed replica per device',
		cookie: 'C. cookie: primary if written within 5 s',
		'token-device': 'D. version token — on the device (cookie)',
		'token-user': 'E. version token — per user (on the server)'
	};
	console.log(
		`\n   primary + ${REPLICAS.length} async replicas; ${SIM_MS / 1000} s, ~${BACKGROUND_WRITES_PER_S} writes a second; ${SESSIONS} times "write, then read ${READ_OFFSETS_MS.length} times"`
	);
	console.log('   (seeded — the same result every time; the lag numbers are an assumed model)\n');
	console.log(
		"                                                  didn't see own write          time went     reads on primary"
	);
	console.log(
		'   strategy                                       same device   other device    back'
	);
	for (const strategy of Object.keys(labels) as Strategy[]) {
		// Object.keys has type string[] — the keys of labels are exactly Strategy, so the assertion is safe
		const r = run(strategy, actions);
		console.log(
			`   ${labels[strategy].padEnd(44)}  ${pct(r.sameDeviceMissed, r.sameDeviceReads)}       ${pct(r.otherDeviceMissed, r.otherDeviceReads)}       ${pct(r.wentBack, r.reads)}       ${pct(r.onPrimary, r.reads)}`
		);
	}
	console.log('');
}

main();
