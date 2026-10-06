export type Step = {
	label: string;
	value: number;
	unit: string;
};

export type Slip = {
	label: string;
	value: number;
};

export type Drill = {
	id: number;
	title: string;
	givens: readonly string[];
	question: string;
	unit: string;
	exact: readonly Step[];
	mental: readonly Step[];
	so: string;
	slip?: Slip;
};

const DAY = 86_400;
const MONTH_MINUTES = 30 * 24 * 60;

const step = (label: string, value: number, unit: string): Step => ({ label, value, unit });

export const answerOf = (steps: readonly Step[]): number => {
	const last = steps[steps.length - 1];
	if (last === undefined) throw new Error('a drill needs at least one step');
	return last.value;
};

function photoReads(): Drill {
	const views = 50e6 * 40;
	const average = views / DAY;
	return {
		id: 1,
		title: 'Photo app: peak reads',
		givens: [
			'50 million daily active users',
			'each views 40 photos a day',
			'peak = 3× the average'
		],
		question: 'Peak photo views per second?',
		unit: 'requests/s',
		exact: [
			step('views per day = 50M × 40', views, 'views/day'),
			step('average = views / 86,400', average, 'req/s'),
			step('peak = average × 3', average * 3, 'req/s')
		],
		mental: [step('2 × 10^9 / 10^5', 2e9 / 1e5, 'req/s'), step('× 3', (2e9 / 1e5) * 3, 'req/s')],
		so: '~70k reads/s at peak: no single database serves this directly. Cache the metadata, serve the images from a CDN (4.1, 4.5).',
		slip: { label: 'forgot the peak (sized for the average)', value: average }
	};
}

function photoStorage(): Drill {
	const perDay = 25e6 * 2e6;
	return {
		id: 2,
		title: 'Photo app: storage per year',
		givens: ['25 million uploads a day', '2 MB per photo on average', 'originals only'],
		question: 'Storage added per year, in PB?',
		unit: 'PB',
		exact: [
			step('per day = 25M × 2 MB', perDay / 1e12, 'TB/day'),
			step('per year = × 365', (perDay * 365) / 1e15, 'PB')
		],
		mental: [
			step('25M × 2 MB = 50 TB', 50, 'TB/day'),
			step('× 400 (≈ a year)', (50 * 400) / 1000, 'PB')
		],
		so: '~18 PB a year: object storage, never the database. Moving old photos to a colder tier is a cost decision (8.1, 10.7).'
	};
}

function videoEgress(): Drill {
	const bits = 2e6 * 3e6;
	return {
		id: 3,
		title: 'Live video: peak egress',
		givens: ['2 million concurrent viewers at peak', '3 Mbps average bitrate'],
		question: 'Peak egress, in Tbps?',
		unit: 'Tbps',
		exact: [step('2M × 3 Mbps', bits / 1e12, 'Tbps')],
		mental: [step('2 × 10^6 × 3 × 10^6 = 6 × 10^12', 6, 'Tbps')],
		so: '6 Tbps: only a CDN can deliver this. The origin serves the CDN, not the viewers (4.5, 11.6).',
		slip: { label: 'mixed bits and bytes (3 MB/s per viewer)', value: (bits * 8) / 1e12 }
	};
}

function apiFleet(): Drill {
	const busy = 30_000 * 0.02;
	const cores = busy / 0.6;
	return {
		id: 4,
		title: 'API fleet: servers',
		givens: [
			'30,000 requests/s at peak',
			'20 ms of CPU per request',
			'8 cores per server',
			'run each server at most 60% busy'
		],
		question: 'How many servers?',
		unit: 'servers',
		exact: [
			step('busy cores = 30,000 × 0.02 s', busy, 'cores'),
			step('with the 60% ceiling = / 0.6', cores, 'cores'),
			step('servers = / 8', cores / 8, 'servers')
		],
		mental: [step('600 / 0.6 ≈ 1,000 cores', 1_000, 'cores'), step('/ 8', 125, 'servers')],
		so: '~125 servers, plus spares per zone. CPU per request is the lever: halving it saves ~60 machines (1.6, 10.7).',
		slip: { label: 'forgot the 60% ceiling (ran at 100%)', value: busy / 8 }
	};
}

function catalogCache(): Drill {
	const hot = 10e6 * 0.2 * 5e3;
	return {
		id: 5,
		title: 'Catalog: cache size',
		givens: [
			'10 million products, 5 KB each as cached JSON',
			'cache the hottest 20%',
			'× 2 for Redis overhead'
		],
		question: 'Cache memory, in GB?',
		unit: 'GB',
		exact: [
			step('hot items = 10M × 0.2', 10e6 * 0.2, 'items'),
			step('× 5 KB', hot / 1e9, 'GB'),
			step('× 2 overhead', (hot * 2) / 1e9, 'GB')
		],
		mental: [step('2M × 5 KB = 10 GB, × 2', 20, 'GB')],
		so: '~20 GB fits in one Redis node with a replica. No cache cluster, no sharding of the cache (4.4).',
		slip: { label: 'read 5 KB as 5 MB', value: (hot * 2 * 1_000) / 1e9 }
	};
}

function chatWrites(): Drill {
	const messages = 100e6 * 40;
	const average = messages / DAY;
	return {
		id: 6,
		title: 'Chat: peak message writes',
		givens: [
			'100 million daily active users',
			'40 messages per user a day',
			'peak = 3× the average'
		],
		question: 'Peak message writes per second?',
		unit: 'writes/s',
		exact: [
			step('messages per day = 100M × 40', messages, 'msg/day'),
			step('average = / 86,400', average, 'writes/s'),
			step('peak = × 3', average * 3, 'writes/s')
		],
		mental: [
			step('4 × 10^9 / 10^5', 4e9 / 1e5, 'writes/s'),
			step('× 3', (4e9 / 1e5) * 3, 'writes/s')
		],
		so: '~140k writes/s: past one primary. Partition by conversation; an LSM-style store suits an append-heavy log (5.3, 5.8, 11.3).',
		slip: { label: 'forgot to divide by 86,400 (per day as per second)', value: messages * 3 }
	};
}

function chatGateways(): Drill {
	const online = 100e6 * 0.2;
	return {
		id: 7,
		title: 'Chat: gateway servers',
		givens: [
			'100 million daily active users',
			'20% online at the peak',
			'one gateway holds 200,000 connections',
			'keep 50% headroom'
		],
		question: 'How many gateway servers?',
		unit: 'servers',
		exact: [
			step('online = 100M × 0.2', online, 'connections'),
			step('/ 200,000 per gateway', online / 200_000, 'servers'),
			step('/ 0.5 for headroom', online / 200_000 / 0.5, 'servers')
		],
		mental: [step('20M / 200k = 100, × 2', 200, 'servers')],
		so: '~200 gateways: the sender must find the gateway that holds the receiver, so a session registry (11.3).'
	};
}

function fanOutTail(): Drill {
	const slow = 1 - 0.99 ** 50;
	return {
		id: 8,
		title: 'Fan-out: tail latency',
		givens: [
			'one request fans out to 50 shards in parallel and waits for all',
			'each shard is slower than 100 ms 1% of the time'
		],
		question: 'Share of requests slower than 100 ms, in %?',
		unit: '%',
		exact: [
			step('all fast = 0.99^50', 0.99 ** 50 * 100, '%'),
			step('slow = 1 − that', slow * 100, '%')
		],
		mental: [step('≈ 50 × 1%', 50, '%')],
		so: '~40% of requests wait for a slow shard: a rare per-shard tail becomes a common request tail. Hedge, or fan out to fewer (11.4).'
	};
}

function availabilityChain(): Drill {
	const up = 0.999 ** 3;
	return {
		id: 9,
		title: 'Availability: three in series',
		givens: [
			'a request passes through 3 services in series',
			'each is 99.9% available',
			'a 30-day month'
		],
		question: 'Downtime per month, in minutes?',
		unit: 'min/month',
		exact: [
			step('availability = 0.999^3', up * 100, '%'),
			step('down = (1 − that) × 43,200 min', (1 - up) * MONTH_MINUTES, 'min/month')
		],
		mental: [
			step('3 × 0.1% = 0.3%', 0.3, '%'),
			step('0.3% × 43,200', 0.003 * MONTH_MINUTES, 'min/month')
		],
		so: '~130 minutes a month, three times one service’s budget. If the product promises 99.9%, take a service off the path or make it async (1.5, 10.3).',
		slip: {
			label: 'used one service’s availability for the chain',
			value: 0.001 * MONTH_MINUTES
		}
	};
}

function logVolume(): Drill {
	const perSecond = 500 * 50 * 500;
	return {
		id: 10,
		title: 'Logs: volume per day',
		givens: ['500 service instances', '50 log lines per second each', '500 bytes per line'],
		question: 'Log volume per day, in GB?',
		unit: 'GB/day',
		exact: [
			step('per second = 500 × 50 × 500 B', perSecond / 1e6, 'MB/s'),
			step('per day = × 86,400', (perSecond * DAY) / 1e9, 'GB/day')
		],
		mental: [step('12.5 MB/s', 12.5, 'MB/s'), step('× 10^5', (12.5e6 * 1e5) / 1e9, 'GB/day')],
		so: '~1 TB a day, ~32 TB for 30 days in a search cluster. Sample the debug logs, keep metrics for trends, tier old logs to object storage (10.4, 10.7).',
		slip: { label: 'forgot the 500 instances', value: (50 * 500 * DAY) / 1e9 }
	};
}

export const drills: readonly Drill[] = [
	photoReads(),
	photoStorage(),
	videoEgress(),
	apiFleet(),
	catalogCache(),
	chatWrites(),
	chatGateways(),
	fanOutTail(),
	availabilityChain(),
	logVolume()
];
