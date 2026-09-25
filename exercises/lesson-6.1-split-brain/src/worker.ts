import { z } from 'zod';

// Lesson 6.1 — TaskFlow এর "due-date reminder" worker। কয়েকটা instance চলে, কিন্তু reminder
// পাঠাবে শুধু একজন — যার হাতে lease (নইলে প্রতিটা email কয়েকবার যাবে)। Leader এর কাজ, প্রতি tick এ:
//
//   ১. lease আছে কিনা দেখো (না থাকলে বা শেষ হয়ে আসলে lock service থেকে নাও/বাড়াও)
//   ২. storage থেকে cursor পড়ো — পরের কোন batch
//   ৩. সেই batch এর reminder email পাঠাও
//   ৪. cursor + 1 লেখো, সাথে নিজের token
//
// PAUSE_AT_BATCH দেওয়া থাকলে, সেই batch এ ধাপ ২ এর ঠিক পরে process পুরোপুরি থেমে যায় —
// একটা synchronous busy loop, stop-the-world GC যেভাবে পুরো thread আটকায় ঠিক সেভাবে।
// থামা অবস্থায় কোনো timer চলে না, lease renew হয় না — আর থামা process জানেও না যে সে থেমে ছিল।

// env হলো runtime input — type assertion না, Zod দিয়ে parse
const env = z
	.object({
		NODE_NAME: z.string().min(1),
		BASE_URL: z.string().url(),
		START: z.coerce.number().int().positive(),
		TICK_MS: z.coerce.number().int().positive().default(200),
		PAUSE_AT_BATCH: z.coerce.number().int().nonnegative().optional(),
		PAUSE_MS: z.coerce.number().int().positive().default(2500)
	})
	.parse(process.env);

const acquireResponse = z.discriminatedUnion('granted', [
	z.object({ granted: z.literal(true), token: z.number(), ttlMs: z.number() }),
	z.object({ granted: z.literal(false), holder: z.string() })
]);
const cursorResponse = z.object({ cursor: z.number() });
const staleResponse = z.object({ error: z.literal('STALE_TOKEN'), highest: z.number() });

type Lease = { token: number; ttlMs: number; localExpiresAt: number };

let lease: Lease | null = null;
let paused = false;

function log(message: string): void {
	// runner এই লাইনগুলো পড়ে service এর event এর সাথে সময় অনুযায়ী মেলায়
	console.log(`${Date.now() - env.START}\t${message}`);
}

async function call(
	method: 'GET' | 'POST' | 'PUT',
	path: string,
	body?: unknown
): Promise<{ status: number; json: unknown }> {
	// connection: close — প্রতি request এ নতুন connection। Node এর fetch এ কিছুক্ষণ idle থাকা
	// keep-alive socket আবার ব্যবহার করলে প্রায় 300 ms অকারণ দেরি দেখা গেছে; সেটা এখানে timeline
	// গুলিয়ে দিত (lease এর মেয়াদই 1000 ms), তাই বাদ।
	const init: RequestInit = {
		method,
		headers: { 'content-type': 'application/json', connection: 'close' }
	};
	if (body !== undefined) init.body = JSON.stringify(body);
	const res = await fetch(`${env.BASE_URL}${path}`, init);
	return { status: res.status, json: await res.json() };
}

function stopTheWorld(ms: number): void {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		// কিছুই না — event loop আটকে আছে, ঠিক একটা লম্বা GC pause এর মতো
	}
}

async function tick(): Promise<void> {
	// ধাপ ১ — lease। নিজের ঘড়িতে মেয়াদ হিসাব করি, request পাঠানোর মুহূর্ত থেকে (নিরাপদ দিকে);
	// অর্ধেক মেয়াদ পেরোলে renew।
	const askedAt = Date.now();
	if (lease === null || askedAt >= lease.localExpiresAt - lease.ttlMs / 2) {
		const result = acquireResponse.parse(
			(await call('POST', '/lock/acquire', { node: env.NODE_NAME })).json
		);
		if (!result.granted) {
			if (lease !== null) log('lease renew হলো না — অন্য কেউ leader, আমি follower');
			lease = null;
			return;
		}
		if (lease === null) log(`leader হলাম (token ${result.token})`);
		lease = { token: result.token, ttlMs: result.ttlMs, localExpiresAt: askedAt + result.ttlMs };
	}

	// এখানে lease নিজের ঘড়িতে valid। নিচের সবকিছু এই বিশ্বাসের উপর চলে।
	const { cursor } = cursorResponse.parse((await call('GET', '/cursor')).json);

	if (env.PAUSE_AT_BATCH === cursor && !paused) {
		paused = true;
		log(`cursor = ${cursor} পড়লাম … তারপর process থেমে গেল (${env.PAUSE_MS} ms, stop-the-world)`);
		stopTheWorld(env.PAUSE_MS);
		log(`আবার চলছি — আমার কাছে মনে হচ্ছে কিছুই হয়নি, batch ${cursor} পাঠাচ্ছি`);
	}

	await call('POST', '/email', { node: env.NODE_NAME, batch: cursor });

	const write = await call('PUT', '/cursor', {
		node: env.NODE_NAME,
		token: lease.token,
		value: cursor + 1
	});
	if (write.status === 409) {
		const { highest } = staleResponse.parse(write.json);
		log(
			`storage লেখা ফিরিয়ে দিল: আমার token ${lease.token} < ${highest} — আমি আর leader না, থামলাম`
		);
		lease = null;
	}
}

async function loop(): Promise<void> {
	for (;;) {
		try {
			await tick();
		} catch (error: unknown) {
			log(`error: ${error instanceof Error ? error.message : String(error)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, env.TICK_MS));
	}
}

void loop();
