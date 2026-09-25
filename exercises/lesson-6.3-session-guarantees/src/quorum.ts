import { mulberry32 } from './random';

// Lesson 6.3 §১.৬ — R + W > N থাকলেও সময় পেছনে যেতে পারে: "ব্যর্থ" লেখার ভূত।
//
// Leaderless store (Lesson 5.9), N = 3 (A, B, C), W = 2, R = 2 — কাগজে R + W > N।
// TaskFlow এর notification counter এর একটা key এর মান v0, তিনটাতেই।
//
// একটা লেখা v1 আসে। A পায়। B আর C তখন ব্যস্ত — timeout। W = 2 পূরণ হয়নি, তাই client কে বলা হয়
// "লেখা ব্যর্থ"। কিন্তু A থেকে v1 **মুছে ফেলা হয় না** — leaderless store এ rollback নেই।
//
// তারপর ১০০ জন user প্রত্যেকে ৫ বার পড়ে (পালাক্রমে)। প্রতিটা পড়া random ২টা replica কে জিজ্ঞেস
// করে আর নতুনতর version টা নেয়। দুটো ভাবে:
//   read repair বন্ধ — শুধু পড়া
//   read repair চালু — পড়ার সময় যে replica পুরনো মান দিল, তাকে নতুনটা লিখে দেওয়া

type Replica = 'A' | 'B' | 'C';
const REPLICAS: Replica[] = ['A', 'B', 'C'];
const USERS = 100;
const READS_EACH = 5;

function run(readRepair: boolean): {
	sawV1: number;
	wentBack: number;
	flipsPerUser: number[];
	finalState: string;
} {
	const random = mulberry32(68);
	const version = new Map<Replica, number>([
		['A', 1], // "ব্যর্থ" লেখাটা শুধু A তে
		['B', 0],
		['C', 0]
	]);
	const lastSeen = new Array<number>(USERS).fill(-1);
	const flips = new Array<number>(USERS).fill(0);
	let sawV1 = 0;
	let wentBack = 0;

	for (let round = 0; round < READS_EACH; round++)
		for (let user = 0; user < USERS; user++) {
			const first = REPLICAS[Math.floor(random() * 3)] ?? 'A';
			const rest = REPLICAS.filter((r) => r !== first);
			const second = rest[Math.floor(random() * 2)] ?? 'B';
			const newest = Math.max(version.get(first) ?? 0, version.get(second) ?? 0);
			if (readRepair) for (const r of [first, second]) version.set(r, newest);
			if (newest === 1) sawV1++;
			const prev = lastSeen[user] ?? -1;
			if (newest < prev) wentBack++;
			if (prev !== -1 && newest !== prev) flips[user] = (flips[user] ?? 0) + 1;
			lastSeen[user] = newest;
		}
	const finalState = REPLICAS.map((r) => `${r}=v${version.get(r) ?? 0}`).join(' ');
	return { sawV1, wentBack, flipsPerUser: flips, finalState };
}

function main(): void {
	console.log(
		'\n   N = 3, W = 2, R = 2 (R + W > N)। লেখা v1 শুধু A তে পৌঁছেছে → client কে বলা হয়েছে "ব্যর্থ"।'
	);
	console.log(
		`   তারপর ${USERS} জন user × ${READS_EACH} বার পড়া (seed দেওয়া — প্রতিবার একই ফল)\n`
	);
	console.log(
		'   read repair    "ব্যর্থ" v1 দেখেছে      v1 দেখার পরে আবার v0     মান ওঠানামা করেছে এমন user    শেষ অবস্থা'
	);
	for (const repair of [false, true]) {
		const r = run(repair);
		const total = USERS * READS_EACH;
		const flippers = r.flipsPerUser.filter((f) => f >= 2).length;
		console.log(
			`   ${(repair ? 'চালু' : 'বন্ধ').padEnd(12)}   ${`${r.sawV1}/${total}`.padStart(9)}              ${String(r.wentBack).padStart(5)}                   ${String(flippers).padStart(5)}                ${r.finalState}`
		);
	}
	console.log('');
}

main();
