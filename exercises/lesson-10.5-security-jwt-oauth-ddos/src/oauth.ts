import { createHash, randomBytes } from 'node:crypto';
import {
	API_AUDIENCE,
	claimsFor,
	naiveVerify,
	newSigningKey,
	publicPem,
	signRs256,
	strictVerify
} from './jwt';
import { heading, padEnd } from './util';

type Defenses = { state: boolean; pkce: boolean; exactRedirect: boolean; singleUse: boolean };
type Grant = {
	user: string;
	clientId: string;
	redirectUri: string;
	challenge: string | null;
	expiresAt: number;
	used: boolean;
};
type Redirect = { to: string; code: string; state: string };
type Pending = { state: string; verifier: string };

const CLIENT_ID = 'taskflow-web';
const CALLBACK = 'https://app.taskflow.test/auth/callback';
// A same-origin open redirect can still leak a code when the full callback is not pinned.
const EVIL_CALLBACK = 'https://app.taskflow.test/redirect?next=https://evil.example/callback';
const CODE_TTL = 60;

const random = (bytes: number): string => randomBytes(bytes).toString('base64url');
const s256 = (verifier: string): string =>
	createHash('sha256').update(verifier).digest('base64url');

class AuthorizationServer {
	readonly #grants = new Map<string, Grant>();
	constructor(readonly defenses: Defenses) {}
	#redirectAllowed(uri: string): boolean {
		if (this.defenses.exactRedirect) return uri === CALLBACK;
		try {
			return new URL(uri).origin === new URL(CALLBACK).origin;
		} catch {
			return false;
		}
	}
	authorize(
		user: string,
		redirectUri: string,
		state: string,
		challenge: string | null,
		now: number
	): Redirect | null {
		if (!this.#redirectAllowed(redirectUri)) return null;
		const code = random(16);
		this.#grants.set(code, {
			user,
			clientId: CLIENT_ID,
			redirectUri,
			challenge: this.defenses.pkce ? challenge : null,
			expiresAt: now + CODE_TTL,
			used: false
		});
		return { to: redirectUri, code, state };
	}
	token(code: string, redirectUri: string, verifier: string | null, now: number): string | null {
		const grant = this.#grants.get(code);
		if (!grant || grant.clientId !== CLIENT_ID || grant.redirectUri !== redirectUri) return null;
		if (now > grant.expiresAt) return null;
		if (grant.used && this.defenses.singleUse) return null;
		if (
			this.defenses.pkce &&
			(grant.challenge === null || verifier === null || s256(verifier) !== grant.challenge)
		)
			return null;
		grant.used = true;
		return grant.user;
	}
}

class TaskFlowClient {
	readonly #pending = new Map<string, Pending>();
	readonly sessions = new Map<string, string>();
	constructor(
		readonly server: AuthorizationServer,
		readonly defenses: Defenses
	) {}
	start(browser: string): Pending {
		const pending = { state: random(24), verifier: random(32) };
		this.#pending.set(browser, pending);
		return pending;
	}
	callback(browser: string, redirect: Redirect, now: number): boolean {
		const pending = this.#pending.get(browser);
		if (this.defenses.state && (!pending || pending.state !== redirect.state)) return false;
		this.#pending.delete(browser);
		const user = this.server.token(redirect.code, CALLBACK, pending?.verifier ?? null, now);
		if (user === null) return false;
		this.sessions.set(browser, user);
		return true;
	}
}

type Attack = {
	name: string;
	run: (server: AuthorizationServer, client: TaskFlowClient) => boolean;
};

const ATTACKS: Attack[] = [
	{
		name: "Login CSRF: mallory's code in alice's browser",
		run: (server, client) => {
			const malloryLogin = new TaskFlowClient(server, client.defenses).start('mallory-browser');
			const malloryRedirect = server.authorize(
				'mallory',
				CALLBACK,
				malloryLogin.state,
				s256(malloryLogin.verifier),
				0
			);
			if (!malloryRedirect) return false;
			client.start('alice-browser');
			client.callback('alice-browser', malloryRedirect, 5);
			return client.sessions.get('alice-browser') === 'mallory';
		}
	},
	{
		name: 'Code theft (mobile scheme / log), mallory redeems first',
		run: (server, client) => {
			const login = client.start('alice-browser');
			const redirect = server.authorize('alice', CALLBACK, login.state, s256(login.verifier), 0);
			if (!redirect) return false;
			return server.token(redirect.code, CALLBACK, null, 3) === 'alice';
		}
	},
	{
		name: 'Code replay: the same code after alice',
		run: (server, client) => {
			const login = client.start('alice-browser');
			const redirect = server.authorize('alice', CALLBACK, login.state, s256(login.verifier), 0);
			if (!redirect || !client.callback('alice-browser', redirect, 2)) return false;
			return server.token(redirect.code, CALLBACK, null, 20) === 'alice';
		}
	},
	{
		name: "redirect_uri bait (open redirect), mallory's PKCE",
		run: (server) => {
			const verifier = random(32);
			const redirect = server.authorize('alice', EVIL_CALLBACK, random(24), s256(verifier), 0);
			if (!redirect) return false;
			return server.token(redirect.code, EVIL_CALLBACK, verifier, 4) === 'alice';
		}
	}
];

const CONFIGS: [string, Defenses][] = [
	['nothing', { state: false, pkce: false, exactRedirect: false, singleUse: false }],
	['state', { state: true, pkce: false, exactRedirect: false, singleUse: false }],
	['PKCE only', { state: false, pkce: true, exactRedirect: false, singleUse: false }],
	['state + PKCE', { state: true, pkce: true, exactRedirect: false, singleUse: false }],
	['all (+exact, single-use)', { state: true, pkce: true, exactRedirect: true, singleUse: true }]
];

heading('Part A - Authorization code flow: four attacks × five sets of defences');
console.log(padEnd('attack', 60) + CONFIGS.map(([name]) => padEnd(name, 26)).join(''));
for (const attack of ATTACKS) {
	let line = padEnd(attack.name, 60);
	for (const [, defenses] of CONFIGS) {
		const server = new AuthorizationServer(defenses);
		const client = new TaskFlowClient(server, defenses);
		line += padEnd(attack.run(server, client) ? 'succeeded ✗' : 'blocked', 26);
	}
	console.log(line);
}

heading('Part B - one legitimate login, with each set');
for (const [name, defenses] of CONFIGS) {
	const server = new AuthorizationServer(defenses);
	const client = new TaskFlowClient(server, defenses);
	const login = client.start('alice-browser');
	const redirect = server.authorize('alice', CALLBACK, login.state, s256(login.verifier), 0);
	const okNow = redirect !== null && client.callback('alice-browser', redirect, 2);
	const late = client.start('alice-late');
	const slow = server.authorize('alice', CALLBACK, late.state, s256(late.verifier), 0);
	const okLate = slow !== null && client.callback('alice-late', slow, CODE_TTL + 30);
	console.log(
		`${padEnd(name, 32)}callback after 2 s: ${okNow ? 'login' : 'failed'}   after ${CODE_TTL + 30} s: ${okLate ? 'login' : 'failed (code expired)'}`
	);
}

heading('Part C - sending an OIDC ID token to the API as an access token');
const now = 1_790_000_000;
const key = newSigningKey('2026-10');
const idToken = signRs256(claimsFor('alice', 'member', now, { aud: CLIENT_ID }), key);
const accessToken = signRs256(claimsFor('alice', 'member', now), key);
const keys = new Map([[key.kid, key.publicKey]]);
for (const [label, token] of [
	['ID token (aud = taskflow-web)', idToken],
	['access token (aud = taskflow-api)', accessToken]
] as const) {
	const loose = naiveVerify(token, publicPem(key));
	const strict = strictVerify(token, keys, API_AUDIENCE, now);
	console.log(
		`${padEnd(label, 38)}API ignoring aud: ${loose.ok ? '200' : '401'}   API checking aud: ${strict.ok ? '200' : `401 ${strict.reason}`}`
	);
}
