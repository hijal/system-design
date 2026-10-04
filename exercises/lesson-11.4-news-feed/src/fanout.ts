import { ACCOUNTS, followersAtRank } from './graph';
import { env, heading, ms, mulberry32, n, percentile, row } from './util';

const SEED = env('SEED', 11);
const POSTS_PER_S = env('POSTS_PER_S', 1_736);
const ACTIVE_SHARE = env('ACTIVE_SHARE', 0.4);
const CAPACITY = env('FANOUT_CAPACITY', 2_000_000);
const SECONDS = env('SECONDS', 600);
const TICK_MS = env('TICK_MS', 100);
const THRESHOLD = env('THRESHOLD', 1_000_000);
const BIG_JOB = env('BIG_JOB', 100_000);
const BIG_SHARE = env('BIG_SHARE', 0.25);

interface Job {
	createdAt: number;
	remaining: number;
	celebrity: boolean;
}

type Policy = { name: string; pushCelebrities: boolean; split: boolean };

const policies: Policy[] = [
	{ name: 'একটা FIFO queue, সবাইকে push', pushCelebrities: true, split: false },
	{
		name: `দুটো queue: বড় job (> ${n(BIG_JOB)}) আলাদা, ক্ষমতার ${BIG_SHARE * 100}%`,
		pushCelebrities: true,
		split: true
	},
	{
		name: `hybrid: ${n(THRESHOLD)} এর বেশি follower push হয় না`,
		pushCelebrities: false,
		split: false
	}
];

const events: [number, number][] = [
	[60_000, 1],
	[200_000, 2],
	[200_000, 3],
	[200_000, 4],
	[200_000, 5],
	[200_000, 6]
];

function drain(
	queue: Job[],
	budget: number,
	now: number,
	done: (job: Job, at: number) => void
): number {
	let left = budget;
	while (left > 0 && queue.length > 0) {
		const job = queue[0];
		if (job === undefined) break;
		const take = Math.min(left, job.remaining);
		job.remaining -= take;
		left -= take;
		if (job.remaining === 0) {
			queue.shift();
			done(job, now);
		}
	}
	return budget - left;
}

heading(
	`${n(POSTS_PER_S)} post/s (peak), fan-out এর ক্ষমতা ${n(CAPACITY)} লেখা/s; ১ মিনিটে সবচেয়ে বড় account, ২০০ s এ পরের ৫টা একসাথে post করে`
);
console.log(
	row([
		['নীতি', 52],
		['সাধারণ post p50', 16],
		['p99', 10],
		['সবচেয়ে খারাপ', 13],
		['> ৫ s দেরি', 11],
		['বড় post শেষ', 13]
	])
);
for (const policy of policies) {
	const random = mulberry32(SEED);
	const small: Job[] = [];
	const big: Job[] = [];
	const normalDelays: number[] = [];
	const celebrityDelays: number[] = [];
	let late = 0;
	const done = (job: Job, at: number): void => {
		const delay = at - job.createdAt;
		if (job.celebrity) celebrityDelays.push(delay);
		else {
			normalDelays.push(delay);
			if (delay > 5_000) late++;
		}
	};
	const enqueue = (job: Job): void => {
		if (job.remaining === 0) return;
		if (policy.split && job.remaining > BIG_JOB) big.push(job);
		else small.push(job);
	};
	const perTick = (CAPACITY * TICK_MS) / 1_000;
	const ticks = (SECONDS * 1_000) / TICK_MS;
	let nextEvent = 0;
	for (let t = 0; t < ticks; t++) {
		const now = t * TICK_MS;
		const arrivals = Math.floor(POSTS_PER_S * (TICK_MS / 1_000) + random());
		for (let i = 0; i < arrivals; i++) {
			const followers = followersAtRank(1 + Math.floor(random() * ACCOUNTS));
			const celebrity = followers > THRESHOLD;
			if (celebrity && !policy.pushCelebrities) continue;
			enqueue({ createdAt: now, remaining: Math.round(followers * ACTIVE_SHARE), celebrity });
		}
		while (nextEvent < events.length && (events[nextEvent]?.[0] ?? Infinity) <= now) {
			const rank = events[nextEvent]?.[1] ?? 1;
			nextEvent++;
			if (!policy.pushCelebrities) continue;
			enqueue({
				createdAt: now,
				remaining: Math.round(followersAtRank(rank) * ACTIVE_SHARE),
				celebrity: true
			});
		}
		const end = now + TICK_MS;
		if (policy.split) {
			const bigBudget = big.length > 0 ? Math.floor(perTick * BIG_SHARE) : 0;
			const used = drain(small, perTick - bigBudget, end, done);
			drain(big, perTick - used, end, done);
		} else drain(small, perTick, end, done);
	}
	normalDelays.sort((a, b) => a - b);
	console.log(
		row([
			[policy.name, 52],
			[ms(percentile(normalDelays, 50)), 16],
			[ms(percentile(normalDelays, 99)), 10],
			[ms(normalDelays[normalDelays.length - 1] ?? 0), 13],
			[n(late), 11],
			[celebrityDelays.length === 0 ? 'pull এ' : ms(Math.max(...celebrityDelays)), 13]
		])
	);
}
console.log(
	'\nদেরি = post থেকে শেষ follower এর timeline এ পৌঁছানো, ১০০ ms এর ধাপে। "> ৫ s দেরি" = কতগুলো সাধারণ post পাঁচ সেকেন্ডের বেশি অপেক্ষা করল।'
);
