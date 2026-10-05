import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// Two kinds of "identity":
//   1. The user's access token — an HS256 JWT (header.payload.signature), issued at login. The gateway verifies it.
//   2. The gateway → service internal header — after verifying, the gateway sets the user id, and (in signed mode) signs it
//      with its own secret, so the service can tell the header really came from the gateway.
// The secrets are fixed for the exercise — in a real system they come from a secret manager (Lesson 10.5).

export const JWT_SECRET = 'lesson-9.2-user-token-secret';
export const INTERNAL_SECRET = 'lesson-9.2-gateway-internal-secret';

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');
const hmac = (secret: string, data: string): Buffer =>
	createHmac('sha256', secret).update(data).digest();

const claimsSchema = z.object({ sub: z.number().int().positive(), exp: z.number() });
export type Claims = z.infer<typeof claimsSchema>;

export function signJwt(claims: Claims, secret = JWT_SECRET): string {
	const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const body = b64url(JSON.stringify(claims));
	return `${head}.${body}.${b64url(hmac(secret, `${head}.${body}`))}`;
}

export function verifyJwt(token: string, nowSec = Date.now() / 1000): Claims | null {
	const [head, body, sig] = token.split('.');
	if (!head || !body || !sig) return null;
	const expected = hmac(JWT_SECRET, `${head}.${body}`);
	const given = Buffer.from(sig, 'base64url');
	// timingSafeEqual throws if the lengths differ — so check the length first
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
	try {
		const claims = claimsSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString()));
		return claims.exp > nowSec ? claims : null;
	} catch {
		return null;
	}
}

// The gateway's internal header: "userId.timestamp.signature"
export function signInternal(userId: number, nowMs = Date.now()): string {
	const data = `${userId}.${nowMs}`;
	return `${data}.${b64url(hmac(INTERNAL_SECRET, data))}`;
}

export function verifyInternal(
	header: string,
	nowMs = Date.now(),
	maxAgeMs = 60_000
): number | null {
	const [id, at, sig] = header.split('.');
	if (!id || !at || !sig) return null;
	const expected = hmac(INTERNAL_SECRET, `${id}.${at}`);
	const given = Buffer.from(sig, 'base64url');
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
	if (Math.abs(nowMs - Number(at)) > maxAgeMs) return null; // to stop an old header being sent again
	const userId = Number(id);
	return Number.isInteger(userId) && userId > 0 ? userId : null;
}
