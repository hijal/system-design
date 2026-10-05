import { PRIMARY, REGIONS, USERS, regionRtt, userRtt, type City, type Region } from './geo';
import {
	env,
	heading,
	lognormal,
	ms,
	mulberry32,
	pct,
	percentile,
	row,
	weightedPercentile
} from './util';

const SAMPLES = env('SAMPLES', 20_000);
const API_CALLS = env('API_CALLS', 3);
const DB_READS = env('DB_READS', 3);
const APP_MS = env('APP_MS', 20);
const AWAY_SHARE = env('AWAY_SHARE', 0.2);
const JITTER = env('JITTER', 0.15);
const SEED = env('SEED', 1_080);

type Topology = {
	name: string;
	edge: boolean;
	appRegion: (city: City, home: Region) => Region;
	readRegion: (app: Region, home: Region) => Region;
	writeRegion: (app: Region, home: Region) => Region;
};

const nearest = (city: City): Region => USERS.find((u) => u.city === city)?.nearest ?? PRIMARY;

const TOPOLOGIES: Topology[] = [
	{
		name: 'all in Singapore',
		edge: false,
		appRegion: () => PRIMARY,
		readRegion: () => PRIMARY,
		writeRegion: () => PRIMARY
	},
	{
		name: '+ TLS at the CDN edge',
		edge: true,
		appRegion: () => PRIMARY,
		readRegion: () => PRIMARY,
		writeRegion: () => PRIMARY
	},
	{
		name: '+ app + read replica in every region',
		edge: true,
		appRegion: (city) => nearest(city),
		readRegion: (app) => app,
		writeRegion: () => PRIMARY
	},
	{
		name: "the workspace's home region (cell)",
		edge: true,
		appRegion: (_city, home) => home,
		readRegion: (_app, home) => home,
		writeRegion: (_app, home) => home
	}
];

type Sample = { board: number; write: number; staleRisk: number };

function sample(topology: Topology, city: City, random: () => number): Sample {
	const jitter = (v: number): number => v * lognormal(random, 1, JITTER);
	const user = USERS.find((u) => u.city === city);
	const homeIsNear = random() >= AWAY_SHARE;
	const others = REGIONS.filter((r) => r !== nearest(city));
	const home = homeIsNear
		? nearest(city)
		: (others[Math.floor(random() * others.length)] ?? PRIMARY);
	const app = topology.appRegion(city, home);
	const read = topology.readRegion(app, home);
	const write = topology.writeRegion(app, home);
	const toApp = jitter(userRtt(city, app));
	const handshake = topology.edge ? 2 * jitter(user?.edgeRtt ?? 10) : 2 * toApp;
	let board = handshake;
	for (let c = 0; c < API_CALLS; c++) {
		board += jitter(userRtt(city, app)) + APP_MS;
		for (let q = 0; q < DB_READS; q++) board += jitter(regionRtt(app, read));
	}
	const writeLatency = jitter(userRtt(city, app)) + APP_MS + 2 * jitter(regionRtt(app, write));
	const replicaLag = read === write ? 0 : jitter(regionRtt(write, read)) / 2 + 20;
	const nextRead = jitter(regionRtt(write, app)) / 2 + jitter(userRtt(city, app));
	return { board, write: writeLatency, staleRisk: replicaLag > nextRead ? 1 : 0 };
}

heading(
	`Part A — opening a board (new connection, ${API_CALLS} API calls, ${DB_READS} queries each) and creating a task; ${Math.round(AWAY_SHARE * 100)}% of workspaces belong to another region`
);
for (const topology of TOPOLOGIES) {
	console.log(`\n${topology.name}`);
	console.log(
		row([
			['city', 14],
			['user', 8],
			['board p50', 12],
			['board p95', 12],
			['create task p50', 17],
			['stale read after write', 24]
		])
	);
	const random = mulberry32(SEED);
	const all: [number, number][] = [];
	for (const u of USERS) {
		const samples = Array.from({ length: SAMPLES }, () => sample(topology, u.city, random));
		const boards = samples.map((s) => s.board).sort((a, b) => a - b);
		const writes = samples.map((s) => s.write).sort((a, b) => a - b);
		const stale = samples.reduce((s, x) => s + x.staleRisk, 0);
		for (const b of boards) all.push([b, u.share / SAMPLES]);
		console.log(
			row([
				[u.city, 14],
				[pct(u.share, 1, 0), 8],
				[ms(percentile(boards, 50)), 12],
				[ms(percentile(boards, 95)), 12],
				[ms(percentile(writes, 50)), 17],
				[pct(stale, SAMPLES, 1), 24]
			])
		);
	}
	console.log(
		row([
			['all (weighted)', 14],
			['', 8],
			[ms(weightedPercentile(all, 50)), 12],
			[ms(weightedPercentile(all, 95)), 12]
		])
	);
}
console.log(
	'\n("stale read after write" = after creating a task, the next read reaches the local replica before replication — 6.3\'s read-your-writes)'
);

heading('Part B — consensus across regions: how long a write takes to commit (majority ack)');
type Placement = { name: string; leader: Region; followers: Region[] };
const PLACEMENTS: Placement[] = [
	{ name: "Singapore's 3 AZs", leader: 'singapore', followers: ['singapore', 'singapore'] },
	{
		name: 'Singapore + Mumbai + Frankfurt',
		leader: 'singapore',
		followers: ['mumbai', 'frankfurt']
	},
	{ name: 'the same, leader in Mumbai', leader: 'mumbai', followers: ['singapore', 'frankfurt'] },
	{
		name: 'four regions, leader in Singapore',
		leader: 'singapore',
		followers: ['mumbai', 'frankfurt', 'virginia']
	},
	{
		name: 'four regions, leader in Frankfurt',
		leader: 'frankfurt',
		followers: ['singapore', 'mumbai', 'virginia']
	}
];
console.log(
	row([
		['where', 36],
		['node', 6],
		['majority', 10],
		['commit', 10],
		['regions it can lose', 38]
	])
);
for (const p of PLACEMENTS) {
	const nodes = p.followers.length + 1;
	const majority = Math.floor(nodes / 2) + 1;
	const acks = p.followers
		.map((f) => (f === p.leader ? 2 : regionRtt(p.leader, f)))
		.sort((a, b) => a - b);
	const commit = acks[majority - 2] ?? 0;
	const regions = new Set([p.leader, ...p.followers]).size;
	const survives =
		regions === 1
			? '0 (lose the region, lose everything)'
			: `${Math.min(regions - 1, nodes - majority)}`;
	console.log(
		row([
			[p.name, 36],
			[String(nodes), 6],
			[String(majority), 10],
			[ms(commit), 10],
			[survives, 38]
		])
	);
}
