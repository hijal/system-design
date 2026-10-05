import { z } from 'zod';
import {
	type Channel,
	createApp,
	NotificationService,
	type Provider,
	type ProviderResult
} from './notify';
import { heading, padEnd } from './util';

class FakeProvider implements Provider {
	readonly stale = new Set<string>();
	readonly timeoutOnce = new Set<string>();
	readonly delivered = new Map<string, string>();
	calls = 0;

	send(channel: Channel, to: string, text: string, key: string): ProviderResult {
		this.calls++;
		if (channel === 'push' && this.stale.has(to)) return { kind: 'unregistered' };
		const id = `${channel}:${key}`;
		if (this.delivered.has(id)) return { kind: 'sent' };
		this.delivered.set(id, `${channel}:${to} ← ${text}`);
		if (this.timeoutOnce.delete(key)) return { kind: 'timeout' };
		return { kind: 'sent' };
	}

	to(prefix: string): string[] {
		return [...this.delivered.values()].filter((line) => line.startsWith(prefix));
	}
}

const Accepted = z.object({ id: z.number(), duplicate: z.boolean() });
const Detail = z.object({
	id: z.number(),
	status: z.object({ kind: z.string() }).passthrough(),
	history: z.array(z.string())
});

let clock = Date.parse('2026-10-04T12:00:00Z');
const provider = new FakeProvider();
const service = new NotificationService(provider, () => clock);

let step = 0;
const show = (what: string, result: string): void => {
	step++;
	console.log(padEnd(step, 4) + padEnd(what, 60) + result);
};

async function main(): Promise<void> {
	const server = createApp(service).listen(0);
	await new Promise<void>((resolve) => server.once('listening', () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('could not get the port');
	const base = `http://127.0.0.1:${address.port}`;
	const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
		const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
		if (body !== undefined) init.body = JSON.stringify(body);
		const res = await fetch(`${base}${path}`, init);
		const text = await res.text();
		return text === '' ? null : JSON.parse(text);
	};
	const notify = async (
		userId: string,
		type: 'otp' | 'order' | 'like' | 'marketing',
		key: string,
		data: Record<string, string> = {}
	): Promise<{ id: number; duplicate: boolean }> =>
		Accepted.parse(await call('POST', '/v1/notify', { userId, type, idempotencyKey: key, data }));

	service.devices.set('alice', new Set(['a-phone']));
	service.devices.set('bob', new Set(['b-phone']));
	service.devices.set('erin', new Set(['e-old', 'e-new']));
	provider.stale.add('e-old');
	for (let i = 0; i < 1_000; i++) service.emails.set(`u${i}`, `u${i}@example.com`);
	for (const u of ['carol', 'dave', 'gina']) service.emails.set(u, `${u}@example.com`);

	heading('one notification service: three priority queues, fake provider, fake clock (UTC)');
	console.log(padEnd('#', 4) + padEnd('step', 60) + 'result');

	for (let i = 0; i < 1_000; i++)
		await notify(`u${i}`, 'marketing', `camp-1-u${i}`, { title: 'festival offer' });
	const otp = await notify('alice', 'otp', 'login-7781', { code: '482913' });
	service.tick(1);
	show("1,000 marketing in the queue, then alice's OTP; 1 sent", provider.to('push:').join('; '));
	const again = await notify('alice', 'otp', 'login-7781', { code: '482913' });
	show(
		'OTP again with the same idempotency key',
		`id ${again.id} (earlier ${otp.id}), duplicate: ${String(again.duplicate)}`
	);
	service.tick(10_000);

	for (let i = 0; i < 50; i++) await notify('bob', 'like', `like-${i}`, { from: `fan${i}` });
	service.tick(10_000);
	const bobBefore = provider.to('push:b-phone').length;
	clock += 30_000;
	service.tick(10_000);
	show("50 likes on bob's post; before the window closes", `${bobBefore} pushes`);
	show(
		'window closes 30 s later',
		`${provider.to('push:b-phone').join('')}; merged ${service.stats.merged}`
	);

	await call('PUT', '/v1/users/carol/preferences', { marketing: false });
	const carol = await notify('carol', 'marketing', 'camp-2-carol');
	service.tick(10);
	const carolStatus = Detail.parse(await call('GET', `/v1/notifications/${carol.id}`));
	show('carol has turned marketing off', carolStatus.status.kind);

	await call('PUT', '/v1/users/dave/preferences', { quietStart: 22, quietEnd: 7 });
	clock = Date.parse('2026-10-04T23:00:00Z');
	const dave = await notify('dave', 'marketing', 'camp-2-dave', { title: 'night offer' });
	service.tick(10);
	const daveNight = Detail.parse(await call('GET', `/v1/notifications/${dave.id}`)).status.kind;
	clock = Date.parse('2026-10-05T07:00:00Z');
	service.tick(10);
	const daveMorning = Detail.parse(await call('GET', `/v1/notifications/${dave.id}`)).status.kind;
	show('dave: marketing at 11 pm, quiet 22–7', `at night: ${daveNight}; at 7 am: ${daveMorning}`);

	const callsBefore = provider.calls;
	await notify('erin', 'otp', 'login-1', { code: '111111' });
	service.tick(10);
	const firstCalls = provider.calls - callsBefore;
	await notify('erin', 'otp', 'login-2', { code: '222222' });
	service.tick(10);
	show(
		'erin has two tokens, one dead; two OTPs',
		`provider calls: ${firstCalls}, then ${provider.calls - callsBefore - firstCalls}; tokens deleted ${service.stats.staleTokensRemoved}`
	);

	await notify('frank', 'otp', 'login-9', { code: '999999' });
	service.tick(10);
	show('frank has no device, OTP', provider.to('sms:').join(''));

	const order = await notify('gina', 'order', 'order-5512', { order: '#5512' });
	provider.timeoutOnce.add(`n-${order.id}`);
	service.tick(10);
	const detail = Detail.parse(await call('GET', `/v1/notifications/${order.id}`));
	show(
		"gina's order email: first call timed out (actually sent)",
		detail.history
			.slice(1)
			.map((h) => h.slice(9))
			.join(' → ')
	);
	const inbox = provider.to('email:gina').length;
	show("in gina's inbox", `${inbox} email${inbox === 1 ? '' : 's'}`);

	server.close();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
