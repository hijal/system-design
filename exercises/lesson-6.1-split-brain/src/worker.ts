import { z } from 'zod';

// Lesson 6.1 — TaskFlow's "due-date reminder" worker. Several instances run, but only one sends
// reminders — the one holding the lease (otherwise every email goes out several times). The leader, on every tick:
//
//   1. check the lease (acquire/extend it from the lock service if it's missing or about to expire)
//   2. read the cursor from storage — which batch is next
//   3. send that batch's reminder emails
//   4. write cursor + 1, along with its own token
//
// With PAUSE_AT_BATCH set, the process stops completely right after step 2 at that batch —
// a synchronous busy loop, exactly the way a stop-the-world GC freezes the whole thread.
// While stopped no timer runs and the lease isn't renewed — and the stopped process doesn't even know it was stopped.

// env is runtime input — no type assertion, parsed with Zod
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
	// the runner reads these lines and matches them by time with the services' events
	console.log(`${Date.now() - env.START}\t${message}`);
}

async function call(
	method: 'GET' | 'POST' | 'PUT',
	path: string,
	body?: unknown
): Promise<{ status: number; json: unknown }> {
	// connection: close — a new connection per request. Reusing a keep-alive socket that has been idle a while
	// in Node's fetch showed a needless delay of about 300 ms; that would have muddled the timeline here
	// (the lease itself is 1000 ms), so it is turned off.
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
		// nothing — the event loop is blocked, just like a long GC pause
	}
}

async function tick(): Promise<void> {
	// Step 1 — the lease. The expiry is computed on our own clock, from the moment the request was sent (the safe side);
	// renew once half the lease has passed.
	const askedAt = Date.now();
	if (lease === null || askedAt >= lease.localExpiresAt - lease.ttlMs / 2) {
		const result = acquireResponse.parse(
			(await call('POST', '/lock/acquire', { node: env.NODE_NAME })).json
		);
		if (!result.granted) {
			if (lease !== null) log('lease not renewed — someone else is leader, I am a follower');
			lease = null;
			return;
		}
		if (lease === null) log(`became leader (token ${result.token})`);
		lease = { token: result.token, ttlMs: result.ttlMs, localExpiresAt: askedAt + result.ttlMs };
	}

	// Here the lease is valid by our own clock. Everything below runs on that belief.
	const { cursor } = cursorResponse.parse((await call('GET', '/cursor')).json);

	if (env.PAUSE_AT_BATCH === cursor && !paused) {
		paused = true;
		log(`read cursor = ${cursor} … then the process stopped (${env.PAUSE_MS} ms, stop-the-world)`);
		stopTheWorld(env.PAUSE_MS);
		log(`running again — as far as I can tell nothing happened, sending batch ${cursor}`);
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
			`storage rejected the write: my token ${lease.token} < ${highest} — I am no longer leader, stopping`
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
