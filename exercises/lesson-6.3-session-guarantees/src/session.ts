import { mulberry32 } from './random';
import { Replica, shuffled, type LagModel } from './replica';

// Lesson 6.3 §১.৩–১.৪ — একটা primary, তিনটা async replica, আর পাঁচ রকম read routing।
//
// TaskFlow এর একটা ব্যস্ত workspace: team এর সবাই মিলে সেকেন্ডে ~২০০টা লেখা (task, comment, status)।
// প্রতিটা লেখা primary তে একটা LSN পায় (Lesson 5.7), আর প্রতিটা replica নিজের lag এ সেটা পায় —
// ক্রমানুসারে (একটা আটকে গেলে পেছনের সবাই আটকায়)।
//
// ৪০০ জন user, প্রত্যেকের দুটো device (phone, laptop)। ২০০০ বার একজন user একটা task বানায়, তারপর
// পড়ে: redirect এ (+5 ms), তারপর +30 ms, +300 ms, +1 s, +3 s এ। প্রথম দুটো পড়া একই device এ,
// বাকিগুলোর অর্ধেক অন্য device এ।
//
// প্রতিটা পড়ায় দুটো প্রশ্ন:
//   read-your-writes — user এর নিজের শেষ লেখা এই পড়ায় আছে? (একই device / অন্য device আলাদা গুনি)
//   monotonic read   — এই পড়া কি user এর আগের কোনো পড়ার চেয়ে **পুরনো**? (সময় পেছনে গেল)

const SIM_MS = 120_000;
const BACKGROUND_WRITES_PER_S = 200;
const USERS = 400;
const SESSIONS = 2000;
const READ_OFFSETS_MS = [5, 30, 300, 1000, 3000];

const REPLICAS: LagModel[] = [
	{ base: 1, mean: 2, stallPerWrite: 0, stallMs: 0 }, // r1 — দ্রুত, কখনো আটকায় না
	{ base: 3, mean: 8, stallPerWrite: 0.00005, stallMs: 1500 }, // r2
	{ base: 5, mean: 20, stallPerWrite: 0.0002, stallMs: 3000 } // r3 — ধীর, মাঝে মাঝে কয়েক সেকেন্ড আটকায়
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
	const lagRandom = mulberry32(64); // প্রতিটা strategy তে হুবহু একই lag
	const routeRandom = mulberry32(65);
	const replicas = REPLICAS.map((model) => new Replica(model, lagRandom));
	let lsn = 0;

	const lastWriteAt = new Map<string, number>(); // device → শেষ লেখার সময় (cookie)
	const sessionWrite = new Map<number, number>(); // session → সেই session এর লেখার LSN
	const userLastSeen = new Map<number, number>(); // user → আগের পড়াগুলোর সবচেয়ে নতুন LSN
	const token = new Map<string, number>(); // device বা user → দেখা/লেখা সবচেয়ে নতুন LSN

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
				// Lesson 5.7 এর সমাধান: এই device গত ৫ সেকেন্ডে লিখে থাকলে primary থেকে
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
					if (seen >= need) return seen; // এই replica যথেষ্ট এগিয়ে
				}
				result.onPrimary++; // কোনো replica এগিয়ে নেই → primary
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
		const mine = sessionWrite.get(action.session) ?? 0; // এই session এ user নিজে যা লিখেছে
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
		random: 'ক. যেকোনো replica (random)',
		sticky: 'খ. device প্রতি একটা নির্দিষ্ট replica',
		cookie: 'গ. cookie: ৫ s এর মধ্যে লিখলে primary',
		'token-device': 'ঘ. version token — device এ (cookie)',
		'token-user': 'ঙ. version token — user এর (server এ)'
	};
	console.log(
		`\n   primary + ${REPLICAS.length} async replica; ${SIM_MS / 1000} s, সেকেন্ডে ~${BACKGROUND_WRITES_PER_S} লেখা; ${SESSIONS} বার "লেখো, তারপর ${READ_OFFSETS_MS.length} বার পড়ো"`
	);
	console.log('   (seed দেওয়া — প্রতিবার একই ফল; lag এর সংখ্যা ধরে নেওয়া মডেল)\n');
	console.log(
		'                                              নিজের লেখা দেখেনি              সময় পেছনে    read primary তে'
	);
	console.log('   কৌশল                                       একই device    অন্য device      গেছে');
	for (const strategy of Object.keys(labels) as Strategy[]) {
		// Object.keys এর type string[] — labels এর key গুলোই Strategy, তাই assertion নিরাপদ
		const r = run(strategy, actions);
		console.log(
			`   ${labels[strategy].padEnd(40)}  ${pct(r.sameDeviceMissed, r.sameDeviceReads)}       ${pct(r.otherDeviceMissed, r.otherDeviceReads)}       ${pct(r.wentBack, r.reads)}       ${pct(r.onPrimary, r.reads)}`
		);
	}
	console.log('');
}

main();
