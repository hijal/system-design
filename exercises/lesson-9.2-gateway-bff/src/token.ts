import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// দুই ধরনের "পরিচয়":
//   ১. User এর access token — HS256 JWT (header.payload.signature), login এর সময় দেওয়া। Gateway যাচাই করে।
//   ২. Gateway → service এর internal header — gateway যাচাইয়ের পরে user id বসায়, আর (signed mode এ) নিজের
//      secret দিয়ে সেটা sign করে, যাতে service বুঝতে পারে header টা সত্যিই gateway থেকে এসেছে।
// Exercise এর জন্য secret গুলো নির্দিষ্ট — আসল system এ secret manager থেকে (Lesson 10.5)।

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
	// সমান দৈর্ঘ্য না হলে timingSafeEqual throw করে — তাই আগে দৈর্ঘ্য
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
	try {
		const claims = claimsSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString()));
		return claims.exp > nowSec ? claims : null;
	} catch {
		return null;
	}
}

// Gateway এর internal header: "userId.timestamp.signature"
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
	if (Math.abs(nowMs - Number(at)) > maxAgeMs) return null; // পুরনো header আবার পাঠানো আটকাতে
	const userId = Number(id);
	return Number.isInteger(userId) && userId > 0 ? userId : null;
}
