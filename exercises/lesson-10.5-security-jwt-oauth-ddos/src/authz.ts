import { randomUUID } from 'node:crypto';
import {
	API_AUDIENCE,
	claimsFor,
	forgeHs256,
	forgeUnsigned,
	naiveVerify,
	newSigningKey,
	publicPem,
	signRs256,
	strictVerify,
	tamperPayload,
	type Claims
} from './jwt';
import { heading, mulberry32, n, padEnd, row, shuffle } from './util';

const WORKSPACES = Number(process.env.WORKSPACES ?? 2_000);
const BOARDS_PER_WORKSPACE = Number(process.env.BOARDS_PER_WORKSPACE ?? 30);
const LEAKED_IDS = Number(process.env.LEAKED_IDS ?? 340);
const UUID_GUESSES = Number(process.env.UUID_GUESSES ?? 1_000_000);
const SEED = Number(process.env.SEED ?? 105);
const NOW = 1_790_000_000;

const identityKey = newSigningKey('2026-10');
const keyring = new Map([[identityKey.kid, identityKey.publicKey]]);
const pem = publicPem(identityKey);

heading('অংশ ক — JWT যাচাই: naive বনাম strict');
const alice = claimsFor('alice', 'member', NOW);
const valid = signRs256(alice, identityKey);
const cases: [string, string][] = [
	['বৈধ token', valid],
	['payload এ role → admin (signature আগেরটা)', tamperPayload(valid, { role: 'admin' })],
	['alg: none, signature খালি', forgeUnsigned({ ...alice, role: 'admin' })],
	[
		'HS256, public key কে secret ধরে sign',
		forgeHs256({ ...alice, role: 'admin' }, pem, identityKey.kid)
	],
	['মেয়াদ ২ ঘণ্টা আগে শেষ', signRs256(claimsFor('alice', 'member', NOW - 8_100), identityKey)],
	['aud = billing-api (অন্য service এর)', signRs256({ ...alice, aud: 'billing-api' }, identityKey)],
	[
		'iss = staging (একই key ভাগ করা)',
		signRs256({ ...alice, iss: 'https://id.staging.taskflow.test' }, identityKey)
	],
	['অন্য key দিয়ে sign (attacker এর নিজের)', signRs256(alice, newSigningKey('2026-10'))]
];
console.log(
	row([
		['token', 46],
		['naive', 22],
		['strict', 30]
	])
);
let naiveAccepted = 0;
let strictAccepted = 0;
for (const [label, token] of cases) {
	const a = naiveVerify(token, pem);
	const b = strictVerify(token, keyring, API_AUDIENCE, NOW);
	if (a.ok) naiveAccepted++;
	if (b.ok) strictAccepted++;
	const show = (r: typeof a): string => (r.ok ? `200 (${r.claims.role})` : `401 ${r.reason}`);
	console.log(
		row([
			[label, 46],
			[show(a), 22],
			[show(b), 30]
		])
	);
}
console.log(
	`\nnaive গ্রহণ করল ${naiveAccepted}/${cases.length}, strict ${strictAccepted}/${cases.length}`
);

type Board = { id: string; ws: string };
type User = { id: string; ws: string; role: Claims['role'] };
type Ctx = { principal: Claims | null; boardId: string };
type Route = { name: string; handle: (ctx: Ctx) => number };

const random = mulberry32(SEED);
const users = new Map<string, User>();
const workspaceIds = Array.from(
	{ length: WORKSPACES },
	(_, i) => `ws-${String(i + 1).padStart(4, '0')}`
);
for (const ws of workspaceIds) users.set(`owner-${ws}`, { id: `owner-${ws}`, ws, role: 'admin' });
const mallory: User = { id: 'mallory', ws: 'ws-0137', role: 'admin' };
users.set(mallory.id, mallory);
const viewer: User = { id: 'bob', ws: 'ws-0137', role: 'member' };
users.set(viewer.id, viewer);

function buildBoards(idFor: (index: number) => string): Map<string, Board> {
	const slots = shuffle(
		workspaceIds.flatMap((ws) => Array.from({ length: BOARDS_PER_WORKSPACE }, () => ws)),
		mulberry32(SEED + 1)
	);
	return new Map(
		slots.map((ws, index) => {
			const id = idFor(index);
			return [id, { id, ws }];
		})
	);
}

function routes(boards: ReadonlyMap<string, Board>, existence: 'leak' | 'hide'): Route[] {
	const user = (p: Claims): User | undefined => users.get(p.sub);
	const member = (p: Claims, b: Board): boolean => user(p)?.ws === b.ws;
	const deny = (): number => (existence === 'hide' ? 404 : 403);
	const guarded =
		(check: (p: Claims, b: Board) => boolean, ok: number) =>
		({ principal, boardId }: Ctx): number => {
			if (!principal) return 401;
			const board = boards.get(boardId);
			if (!board) return 404;
			return check(principal, board) ? ok : deny();
		};
	return [
		{ name: 'GET    /boards/:id', handle: guarded(member, 200) },
		{ name: 'GET    /boards/:id/tasks', handle: guarded(member, 200) },
		{ name: 'PATCH  /boards/:id', handle: guarded(member, 200) },
		{ name: 'GET    /boards/:id/activity', handle: guarded(member, 200) },
		{ name: 'POST   /boards/:id/share-link', handle: guarded(member, 201) },
		{ name: 'GET    /boards/:id/export', handle: guarded(() => true, 200) },
		{
			name: 'DELETE /boards/:id',
			handle: guarded((p, b) => p.role === 'admin' || member(p, b), 204)
		},
		{
			name: 'POST   /boards/:id/archive',
			handle: guarded((p, b) => member(p, b) && user(p)?.role === 'admin', 200)
		}
	];
}

const token = (u: User): Claims => claimsFor(u.id, u.role, NOW);
const ok = (status: number): boolean => status >= 200 && status < 300;

heading('অংশ খ — BOLA: mallory এর বৈধ token, sequential board id 1..N');
const sequential = buildBoards((i) => String(i + 1));
const malloryClaims = token(mallory);
console.log(
	`${n(WORKSPACES)} workspace × ${BOARDS_PER_WORKSPACE} board = ${n(sequential.size)} board; mallory নিজের free workspace (${mallory.ws}) এর admin\n`
);
console.log(
	row([
		['route', 32],
		['অন্যের board পেল', 18],
		['অস্তিত্ব জানল', 16]
	])
);
const leakTable = routes(sequential, 'leak');
for (const route of leakTable) {
	let stolen = 0;
	let revealed = 0;
	for (const board of sequential.values()) {
		if (board.ws === mallory.ws) continue;
		const status = route.handle({ principal: malloryClaims, boardId: board.id });
		if (ok(status)) stolen++;
		if (status !== 404) revealed++;
	}
	console.log(
		row([
			[route.name, 32],
			[n(stolen), 18],
			[n(revealed), 16]
		])
	);
}

heading('অংশ গ — id কে UUID করলে কি সমাধান?');
const uuidBoards = buildBoards(() => randomUUID());
const exportRoute = routes(uuidBoards, 'hide').find((r) => r.name.includes('export'));
if (exportRoute) {
	let guessedHits = 0;
	for (let i = 0; i < UUID_GUESSES; i++)
		if (ok(exportRoute.handle({ principal: malloryClaims, boardId: randomUUID() }))) guessedHits++;
	const foreign = [...uuidBoards.values()].filter((b) => b.ws !== mallory.ws);
	const leaked = shuffle(foreign, random).slice(0, LEAKED_IDS);
	const leakedHits = leaked.filter((b) =>
		ok(exportRoute.handle({ principal: malloryClaims, boardId: b.id }))
	).length;
	console.log(
		row([
			['mallory এর চেষ্টা', 44],
			['চেষ্টা', 12],
			['অন্যের board পেল', 18]
		])
	);
	console.log(
		row([
			['এলোমেলো UUID অনুমান', 44],
			[n(UUID_GUESSES), 12],
			[n(guessedHits), 18]
		])
	);
	console.log(
		row([
			['ফাঁস হওয়া support log থেকে পাওয়া id', 44],
			[n(leaked.length), 12],
			[n(leakedHits), 18]
		])
	);
}

heading('অংশ ঘ — authorization matrix test (প্রতিটা route × প্রতিটা actor)');
const target = [...sequential.values()].find((b) => b.ws === 'ws-0042');
const actors: [string, Claims | null, number[]][] = [
	['মালিক', token({ id: 'owner-ws-0042', ws: 'ws-0042', role: 'admin' }), [200, 201, 204]],
	['অন্য ws এর member', token(viewer), [404]],
	['অন্য ws এর admin', malloryClaims, [404]],
	['token ছাড়া', null, [401]]
];
console.log(padEnd('route', 32) + actors.map(([name]) => padEnd(name, 20)).join('') + 'ফল');
let failures = 0;
if (target) {
	for (const route of routes(sequential, 'hide')) {
		let line = padEnd(route.name, 32);
		let routeFails = 0;
		for (const [, principal, expected] of actors) {
			const status = route.handle({ principal, boardId: target.id });
			const pass = expected.includes(status);
			if (!pass) routeFails++;
			line += padEnd(`${status}${pass ? '' : ' ✗'}`, 20);
		}
		failures += routeFails;
		console.log(line + (routeFails === 0 ? 'pass' : 'FAIL'));
	}
}
console.log(`\n${failures}টা ঘর ব্যর্থ — CI তে এই test থাকলে merge এর আগে ধরা পড়ত`);
