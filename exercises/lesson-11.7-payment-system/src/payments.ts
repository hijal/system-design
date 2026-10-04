import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';

export type PspResult = { kind: 'charged' } | { kind: 'declined' } | { kind: 'timeout' };

export interface Psp {
	charge(ref: string, amount: number): PspResult;
	refund(ref: string, amount: number): PspResult;
	status(ref: string): 'charged' | 'not-found';
}

export type PaymentState =
	| { kind: 'created' }
	| { kind: 'unknown'; since: number }
	| { kind: 'succeeded' }
	| { kind: 'failed'; reason: string };

interface Payment {
	id: string;
	merchantId: string;
	amount: number;
	refunded: number;
	idempotencyKey: string;
	state: PaymentState;
	history: string[];
}

interface Entry {
	tx: string;
	account: string;
	amount: number;
}

const CreatePayment = z.object({
	amount: z.number().int().positive().max(100_000_000),
	currency: z.literal('USD'),
	merchantId: z.string().regex(/^m_[a-z0-9]{1,20}$/),
	idempotencyKey: z.string().min(8).max(100)
});
const CreateRefund = z.object({
	amount: z.number().int().positive(),
	idempotencyKey: z.string().min(8).max(100)
});
const Webhook = z.object({ ref: z.string(), status: z.enum(['charged', 'failed']) });

export const fee = (amount: number): number => Math.round(amount * 0.029) + 30;

export class PaymentService {
	readonly payments = new Map<string, Payment>();
	readonly byKey = new Map<string, string>();
	readonly refundKeys = new Map<string, number>();
	readonly ledger: Entry[] = [];
	private nextId = 1;

	constructor(
		private readonly psp: Psp,
		private readonly webhookSecret: string,
		private readonly now: () => number
	) {}

	private post(tx: string, lines: [string, number][]): void {
		const sum = lines.reduce((s, [, a]) => s + a, 0);
		if (sum !== 0) throw new Error(`unbalanced transaction ${tx}: ${sum}`);
		for (const [account, amount] of lines) this.ledger.push({ tx, account, amount });
	}

	private succeed(p: Payment, how: string): void {
		if (p.state.kind === 'succeeded') return;
		p.state = { kind: 'succeeded' };
		p.history.push(`succeeded (${how})`);
		const f = fee(p.amount);
		this.post(`capture:${p.id}`, [
			['psp_receivable', p.amount],
			[`merchant:${p.merchantId}`, -(p.amount - f)],
			['revenue:fees', -f]
		]);
	}

	create(body: z.infer<typeof CreatePayment>): Payment {
		const existing = this.byKey.get(`${body.merchantId}:${body.idempotencyKey}`);
		const found = existing === undefined ? undefined : this.payments.get(existing);
		if (found !== undefined) return found;
		const p: Payment = {
			id: `pay_${this.nextId++}`,
			merchantId: body.merchantId,
			amount: body.amount,
			refunded: 0,
			idempotencyKey: body.idempotencyKey,
			state: { kind: 'created' },
			history: ['created']
		};
		this.payments.set(p.id, p);
		this.byKey.set(`${body.merchantId}:${body.idempotencyKey}`, p.id);
		const result = this.psp.charge(p.id, p.amount);
		p.history.push(`psp: ${result.kind}`);
		if (result.kind === 'charged') this.succeed(p, 'psp');
		else if (result.kind === 'declined') p.state = { kind: 'failed', reason: 'card_declined' };
		else p.state = { kind: 'unknown', since: this.now() };
		return p;
	}

	webhook(raw: string, signature: string): 'ok' | 'bad-signature' | 'unknown-payment' {
		const expected = createHmac('sha256', this.webhookSecret).update(raw).digest();
		const given = Buffer.from(signature, 'hex');
		if (given.length !== expected.length || !timingSafeEqual(given, expected))
			return 'bad-signature';
		const body = Webhook.safeParse(JSON.parse(raw));
		if (!body.success) return 'bad-signature';
		const p = this.payments.get(body.data.ref);
		if (p === undefined) return 'unknown-payment';
		if (body.data.status === 'charged') this.succeed(p, 'webhook');
		else if (p.state.kind !== 'succeeded') p.state = { kind: 'failed', reason: 'psp_failed' };
		return 'ok';
	}

	recover(olderThanMs: number): number {
		let fixed = 0;
		for (const p of this.payments.values()) {
			const stuck =
				p.state.kind === 'created' ||
				(p.state.kind === 'unknown' && this.now() - p.state.since >= olderThanMs);
			if (!stuck) continue;
			if (this.psp.status(p.id) === 'charged') this.succeed(p, 'recovery');
			else {
				p.state = { kind: 'failed', reason: 'not_charged' };
				p.history.push('failed (recovery)');
			}
			fixed++;
		}
		return fixed;
	}

	refund(
		id: string,
		amount: number,
		key: string
	): 'ok' | 'duplicate' | 'not-found' | 'not-refundable' | 'exceeds' {
		const p = this.payments.get(id);
		if (p === undefined) return 'not-found';
		if (this.refundKeys.has(`${id}:${key}`)) return 'duplicate';
		if (p.state.kind !== 'succeeded') return 'not-refundable';
		if (p.refunded + amount > p.amount) return 'exceeds';
		const result = this.psp.refund(p.id, amount);
		if (result.kind !== 'charged') return 'not-refundable';
		this.refundKeys.set(`${id}:${key}`, amount);
		p.refunded += amount;
		p.history.push(`refund ${amount}`);
		const back = Math.round((fee(p.amount) * amount) / p.amount);
		this.post(`refund:${p.id}:${key}`, [
			['psp_receivable', -amount],
			[`merchant:${p.merchantId}`, amount - back],
			['revenue:fees', back]
		]);
		return 'ok';
	}

	balances(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const e of this.ledger) out[e.account] = (out[e.account] ?? 0) + e.amount;
		return out;
	}

	reconcile(report: readonly { ref: string; amount: number }[]): string[] {
		const issues: string[] = [];
		const seen = new Map<string, number>();
		for (const r of report) seen.set(r.ref, (seen.get(r.ref) ?? 0) + 1);
		for (const [ref, count] of seen) {
			const p = this.payments.get(ref);
			if (p === undefined) issues.push(`${ref}: PSP তে আছে, আমাদের নেই`);
			else if (p.state.kind !== 'succeeded')
				issues.push(`${ref}: PSP কেটেছে, আমরা ${p.state.kind}`);
			else if (count > 1) issues.push(`${ref}: PSP তে ${count} বার`);
		}
		for (const p of this.payments.values())
			if (p.state.kind === 'succeeded' && !seen.has(p.id))
				issues.push(`${p.id}: আমাদের succeeded, PSP তে নেই`);
		return issues;
	}
}

export function createApp(service: PaymentService): Express {
	const app = express();
	app.post('/v1/webhooks/psp', express.text({ type: '*/*' }), (req: Request, res: Response) => {
		const raw = typeof req.body === 'string' ? req.body : '';
		const result = service.webhook(raw, req.get('x-signature') ?? '');
		res.status(result === 'ok' ? 200 : result === 'bad-signature' ? 401 : 404).json({ result });
	});
	app.use(express.json({ limit: '4kb' }));
	app.post('/v1/payments', (req: Request, res: Response) => {
		const body = CreatePayment.safeParse(req.body);
		if (!body.success) {
			res.status(400).json({ error: 'invalid_body' });
			return;
		}
		const before = service.payments.size;
		const p = service.create(body.data);
		const replay = service.payments.size === before;
		res
			.status(
				replay ? 200 : p.state.kind === 'failed' ? 402 : p.state.kind === 'unknown' ? 202 : 201
			)
			.json({ id: p.id, state: p.state });
	});
	app.get('/v1/payments/:id', (req: Request<{ id: string }>, res: Response) => {
		const p = service.payments.get(req.params.id);
		if (p === undefined) {
			res.status(404).json({ error: 'not_found' });
			return;
		}
		res.json({
			id: p.id,
			amount: p.amount,
			refunded: p.refunded,
			state: p.state,
			history: p.history
		});
	});
	app.post('/v1/payments/:id/refunds', (req: Request<{ id: string }>, res: Response) => {
		const body = CreateRefund.safeParse(req.body);
		if (!body.success) {
			res.status(400).json({ error: 'invalid_body' });
			return;
		}
		const result = service.refund(req.params.id, body.data.amount, body.data.idempotencyKey);
		const status = {
			ok: 201,
			duplicate: 200,
			'not-found': 404,
			'not-refundable': 409,
			exceeds: 409
		}[result];
		res.status(status).json({ result });
	});
	return app;
}
