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
	console.log(padEnd(step, 4) + padEnd(what, 54) + result);
};

async function main(): Promise<void> {
	const server = createApp(service).listen(0);
	await new Promise<void>((resolve) => server.once('listening', () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('port পাওয়া গেল না');
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

	heading('একটা notification service: অগ্রাধিকারের তিনটা queue, fake provider, নকল ঘড়ি (UTC)');
	console.log(padEnd('#', 4) + padEnd('ধাপ', 54) + 'ফল');

	for (let i = 0; i < 1_000; i++)
		await notify(`u${i}`, 'marketing', `camp-1-u${i}`, { title: 'পূজার অফার' });
	const otp = await notify('alice', 'otp', 'login-7781', { code: '482913' });
	service.tick(1);
	show(
		'১,০০০টা marketing queue তে, তারপর alice এর OTP; ১টা পাঠানো',
		provider.to('push:').join('; ')
	);
	const again = await notify('alice', 'otp', 'login-7781', { code: '482913' });
	show(
		'একই idempotency key তে OTP আবার',
		`id ${again.id} (আগেরটা ${otp.id}), duplicate: ${String(again.duplicate)}`
	);
	service.tick(10_000);

	for (let i = 0; i < 50; i++) await notify('bob', 'like', `like-${i}`, { from: `fan${i}` });
	service.tick(10_000);
	const bobBefore = provider.to('push:b-phone').length;
	clock += 30_000;
	service.tick(10_000);
	show('bob এর post এ ৫০টা like; জানালা বন্ধের আগে', `push ${bobBefore}টা`);
	show(
		'৩০ s পরে জানালা বন্ধ',
		`${provider.to('push:b-phone').join('')}; মেশানো ${service.stats.merged}`
	);

	await call('PUT', '/v1/users/carol/preferences', { marketing: false });
	const carol = await notify('carol', 'marketing', 'camp-2-carol');
	service.tick(10);
	const carolStatus = Detail.parse(await call('GET', `/v1/notifications/${carol.id}`));
	show('carol marketing বন্ধ রেখেছে', carolStatus.status.kind);

	await call('PUT', '/v1/users/dave/preferences', { quietStart: 22, quietEnd: 7 });
	clock = Date.parse('2026-10-04T23:00:00Z');
	const dave = await notify('dave', 'marketing', 'camp-2-dave', { title: 'রাতের অফার' });
	service.tick(10);
	const daveNight = Detail.parse(await call('GET', `/v1/notifications/${dave.id}`)).status.kind;
	clock = Date.parse('2026-10-05T07:00:00Z');
	service.tick(10);
	const daveMorning = Detail.parse(await call('GET', `/v1/notifications/${dave.id}`)).status.kind;
	show('dave: রাত ১১টায় marketing, নীরবতা ২২–৭', `রাতে: ${daveNight}; সকাল ৭টায়: ${daveMorning}`);

	const callsBefore = provider.calls;
	await notify('erin', 'otp', 'login-1', { code: '111111' });
	service.tick(10);
	const firstCalls = provider.calls - callsBefore;
	await notify('erin', 'otp', 'login-2', { code: '222222' });
	service.tick(10);
	show(
		'erin এর দুটো token, একটা মৃত; দুটো OTP',
		`provider call: ${firstCalls}, তারপর ${provider.calls - callsBefore - firstCalls}; মুছে ফেলা token ${service.stats.staleTokensRemoved}`
	);

	await notify('frank', 'otp', 'login-9', { code: '999999' });
	service.tick(10);
	show('frank এর কোনো device নেই, OTP', provider.to('sms:').join(''));

	const order = await notify('gina', 'order', 'order-5512', { order: '#5512' });
	provider.timeoutOnce.add(`n-${order.id}`);
	service.tick(10);
	const detail = Detail.parse(await call('GET', `/v1/notifications/${order.id}`));
	show(
		'gina এর অর্ডার email: প্রথম call timeout (আসলে গিয়েছিল)',
		detail.history
			.slice(1)
			.map((h) => h.slice(9))
			.join(' → ')
	);
	show('gina এর inbox এ', `${provider.to('email:gina').length}টা email`);

	server.close();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
