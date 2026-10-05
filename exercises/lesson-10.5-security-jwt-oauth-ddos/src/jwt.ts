import {
	createHmac,
	createPublicKey,
	generateKeyPairSync,
	sign,
	timingSafeEqual,
	verify,
	type KeyObject
} from 'node:crypto';
import { z } from 'zod';

export const ISSUER = 'https://id.taskflow.test';
export const API_AUDIENCE = 'taskflow-api';
export const CLOCK_SKEW_SECONDS = 60;

const headerSchema = z.object({
	alg: z.string(),
	typ: z.string().optional(),
	kid: z.string().optional()
});

const claimsSchema = z.object({
	iss: z.string(),
	sub: z.string().min(1),
	aud: z.string(),
	iat: z.number().int(),
	exp: z.number().int(),
	role: z.enum(['member', 'admin']),
	jti: z.string().min(1)
});

export type Claims = z.infer<typeof claimsSchema>;
export type Verified = { ok: true; claims: Claims } | { ok: false; reason: string };

export type SigningKey = { kid: string; privateKey: KeyObject; publicKey: KeyObject };

export function newSigningKey(kid: string): SigningKey {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	return { kid, privateKey, publicKey };
}

const encode = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

function decodeJson(part: string): unknown {
	try {
		return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
	} catch {
		return undefined;
	}
}

function split(token: string): [string, string, string] | null {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [h, p, s] = parts;
	if (h === undefined || p === undefined || s === undefined) return null;
	return [h, p, s];
}

export function signRs256(claims: Claims, key: SigningKey): string {
	const input = `${encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid }))}.${encode(JSON.stringify(claims))}`;
	return `${input}.${encode(sign('sha256', Buffer.from(input), key.privateKey))}`;
}

export function forgeUnsigned(claims: Claims): string {
	return `${encode(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${encode(JSON.stringify(claims))}.`;
}

export function forgeHs256(claims: Claims, secret: string, kid: string): string {
	const input = `${encode(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid }))}.${encode(JSON.stringify(claims))}`;
	return `${input}.${encode(createHmac('sha256', secret).update(input).digest())}`;
}

export function tamperPayload(token: string, change: Partial<Claims>): string {
	const parts = split(token);
	if (!parts) return token;
	const [h, p, s] = parts;
	const original = claimsSchema.safeParse(decodeJson(p));
	if (!original.success) return token;
	return `${h}.${encode(JSON.stringify({ ...original.data, ...change }))}.${s}`;
}

export const publicPem = (key: SigningKey): string =>
	key.publicKey.export({ type: 'spki', format: 'pem' }).toString();

export function naiveVerify(token: string, publicKeyPem: string): Verified {
	const parts = split(token);
	if (!parts) return { ok: false, reason: 'malformed' };
	const [h, p, s] = parts;
	const header = headerSchema.safeParse(decodeJson(h));
	if (!header.success) return { ok: false, reason: 'bad header' };
	const input = Buffer.from(`${h}.${p}`);
	const signature = Buffer.from(s, 'base64url');
	let valid = false;
	if (header.data.alg === 'none') valid = true;
	else if (header.data.alg === 'HS256') {
		const expected = createHmac('sha256', publicKeyPem).update(input).digest();
		valid = expected.length === signature.length && timingSafeEqual(expected, signature);
	} else if (header.data.alg === 'RS256') {
		valid = verify('sha256', input, createPublicKey(publicKeyPem), signature);
	}
	if (!valid) return { ok: false, reason: 'invalid signature' };
	const claims = claimsSchema.safeParse(decodeJson(p));
	return claims.success ? { ok: true, claims: claims.data } : { ok: false, reason: 'bad claims' };
}

export function strictVerify(
	token: string,
	keys: ReadonlyMap<string, KeyObject>,
	audience: string,
	nowSeconds: number
): Verified {
	const parts = split(token);
	if (!parts) return { ok: false, reason: 'malformed' };
	const [h, p, s] = parts;
	const header = headerSchema.safeParse(decodeJson(h));
	if (!header.success) return { ok: false, reason: 'bad header' };
	if (header.data.alg !== 'RS256')
		return { ok: false, reason: `alg ${header.data.alg} not in the allowlist` };
	const key = header.data.kid === undefined ? undefined : keys.get(header.data.kid);
	if (!key) return { ok: false, reason: 'unknown kid' };
	if (!verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')))
		return { ok: false, reason: 'signature mismatch' };
	const claims = claimsSchema.safeParse(decodeJson(p));
	if (!claims.success) return { ok: false, reason: 'claims have the wrong shape' };
	const c = claims.data;
	if (c.iss !== ISSUER) return { ok: false, reason: 'iss mismatch' };
	if (c.aud !== audience) return { ok: false, reason: 'aud mismatch' };
	if (c.exp <= nowSeconds - CLOCK_SKEW_SECONDS) return { ok: false, reason: 'expired' };
	if (c.iat > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'iat in the future' };
	return { ok: true, claims: c };
}

export function claimsFor(
	sub: string,
	role: Claims['role'],
	nowSeconds: number,
	overrides: Partial<Claims> = {}
): Claims {
	return {
		iss: ISSUER,
		sub,
		aud: API_AUDIENCE,
		iat: nowSeconds,
		exp: nowSeconds + 900,
		role,
		jti: `${sub}-${nowSeconds}`,
		...overrides
	};
}
