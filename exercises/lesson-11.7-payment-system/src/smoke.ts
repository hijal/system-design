import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { createApp, PaymentService, type Psp, type PspResult } from './payments';
import { heading, padEnd } from './util';

class FakePsp implements Psp {
	readonly charges = new Map<string, number>();
	readonly declined = new Set<number>();
	readonly timeoutOnce = new Set<number>();
	readonly extra: { ref: string; amount: number }[] = [];
	calls = 0;

	charge(ref: string, amount: number): PspResult {
		this.calls++;
		if (this.declined.has(amount)) return { kind: 'declined' };
		if (!this.charges.has(ref)) this.charges.set(ref, amount);
		if (this.timeoutOnce.delete(amount)) return { kind: 'timeout' };
		return { kind: 'charged' };
	}

	refund(): PspResult {
		return { kind: 'charged' };
	}

	status(ref: string): 'charged' | 'not-found' {
		return this.charges.has(ref) ? 'charged' : 'not-found';
	}

	report(): { ref: string; amount: number }[] {
		return [...[...this.charges].map(([ref, amount]) => ({ ref, amount })), ...this.extra];
	}
}

const SECRET = 'whsec_demo_only';
let clock = Date.parse('2026-10-05T10:00:00Z');
const psp = new FakePsp();
const service = new PaymentService(psp, SECRET, () => clock);
const Answer = z.object({ id: z.string(), state: z.object({ kind: z.string() }).passthrough() });

let step = 0;
const show = (what: string, result: string): void => {
	step++;
	console.log(padEnd(step, 4) + padEnd(what, 54) + result);
};
const cents = (value: number): string =>
	`${value < 0 ? '−' : ''}$${(Math.abs(value) / 100).toFixed(2)}`;
const balances = (): string =>
	Object.entries(service.balances())
		.map(([k, v]) => `${k} ${cents(v)}`)
		.join(', ');
const total = (): number => Object.values(service.balances()).reduce((a, b) => a + b, 0);

async function main(): Promise<void> {
	const server = createApp(service).listen(0);
	await new Promise<void>((resolve) => server.once('listening', () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('port পাওয়া গেল না');
	const base = `http://127.0.0.1:${address.port}`;
	const pay = async (
		amount: number,
		key: string
	): Promise<{ status: number; id: string; state: string }> => {
		const res = await fetch(`${base}/v1/payments`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ amount, currency: 'USD', merchantId: 'm_shop', idempotencyKey: key })
		});
		const body = Answer.parse(await res.json());
		return { status: res.status, id: body.id, state: body.state.kind };
	};
	const webhook = async (payload: object, secret = SECRET): Promise<number> => {
		const raw = JSON.stringify(payload);
		const signature = createHmac('sha256', secret).update(raw).digest('hex');
		const res = await fetch(`${base}/v1/webhooks/psp`, {
			method: 'POST',
			headers: { 'x-signature': signature },
			body: raw
		});
		await res.text();
		return res.status;
	};
	const refund = async (id: string, amount: number, key: string): Promise<string> => {
		const res = await fetch(`${base}/v1/payments/${id}/refunds`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ amount, idempotencyKey: key })
		});
		return `${res.status} ${z.object({ result: z.string() }).parse(await res.json()).result}`;
	};
	const state = async (id: string): Promise<string> =>
		Answer.parse(await (await fetch(`${base}/v1/payments/${id}`)).json()).state.kind;

	heading(
		'একটা payment service: পয়সায় integer, double-entry ledger, fake PSP, HMAC দেওয়া webhook'
	);
	console.log(padEnd('#', 4) + padEnd('ধাপ', 54) + 'ফল');

	const first = await pay(3_000, 'order-1001-a');
	show('$30.00 এর payment', `${first.status} ${first.state}; ${balances()}`);
	const again = await pay(3_000, 'order-1001-a');
	show(
		'একই idempotency key আবার (client এর retry)',
		`${again.status} ${again.id} (আগেরটা ${first.id}); PSP call ${psp.calls}`
	);

	psp.declined.add(4_200);
	const declined = await pay(4_200, 'order-1002-a');
	show(
		'$42.00, card decline',
		`${declined.status} ${declined.state}; ledger এ entry ${service.ledger.length}টা`
	);

	psp.timeoutOnce.add(5_500);
	const unknown = await pay(5_500, 'order-1003-a');
	show('$55.00, PSP timeout (আসলে কেটেছে)', `${unknown.status} ${unknown.state}`);
	show(
		'PSP এর webhook এলো (সঠিক signature)',
		`${await webhook({ ref: unknown.id, status: 'charged' })} → ${await state(unknown.id)}`
	);
	show(
		'জাল webhook (ভুল secret)',
		`${await webhook({ ref: first.id, status: 'failed' }, 'guess')}; ${first.id} এখনও ${await state(first.id)}`
	);

	psp.timeoutOnce.add(7_700);
	const lost = await pay(7_700, 'order-1004-a');
	clock += 5 * 60_000;
	const fixed = service.recover(2 * 60_000);
	show(
		'$77.00 timeout, webhook হারাল; ৫ মিনিট পরে recovery job',
		`${fixed}টা ঠিক হলো → ${await state(lost.id)}`
	);

	show('$30.00 থেকে $10.00 refund', await refund(first.id, 1_000, 'refund-1-aaaa'));
	show('একই refund key আবার', await refund(first.id, 1_000, 'refund-1-aaaa'));
	show('আরও $25.00 refund (মোট captured ছাড়ায়)', await refund(first.id, 2_500, 'refund-2-aaaa'));

	psp.extra.push({ ref: unknown.id, amount: 5_500 });
	const issues = service.reconcile(psp.report());
	show('দিনশেষে PSP এর report মেলানো', issues.length === 0 ? 'সব মিলেছে' : issues.join('; '));

	show('ledger এর শেষ অবস্থা', balances());
	show('সব entry এর যোগফল', `${total()} পয়সা (${service.ledger.length}টা entry)`);
	server.close();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
