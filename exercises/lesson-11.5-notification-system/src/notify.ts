import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';

export const NotifyBody = z.object({
	userId: z.string().regex(/^[a-z0-9_]{1,30}$/),
	type: z.enum(['otp', 'order', 'like', 'marketing']),
	idempotencyKey: z.string().min(4).max(100),
	data: z.record(z.string(), z.string().max(200)).default({})
});
export type NotifyBody = z.infer<typeof NotifyBody>;

const Preferences = z.object({
	marketing: z.boolean().default(true),
	quietStart: z.number().int().min(0).max(23).optional(),
	quietEnd: z.number().int().min(0).max(23).optional()
});
type Preferences = z.infer<typeof Preferences>;

export type Channel = 'push' | 'email' | 'sms';
type Priority = 'critical' | 'normal' | 'bulk';

export type ProviderResult =
	{ kind: 'sent' } | { kind: 'unregistered' } | { kind: 'timeout' } | { kind: 'failed' };

export interface Provider {
	send(channel: Channel, to: string, text: string, key: string): ProviderResult;
}

export type Status =
	| { kind: 'queued' }
	| { kind: 'aggregating'; until: number }
	| { kind: 'deferred'; until: number }
	| { kind: 'suppressed'; reason: string }
	| { kind: 'sent'; channel: Channel; attempts: number }
	| { kind: 'merged'; into: number }
	| { kind: 'failed'; reason: string };

interface Notification {
	id: number;
	body: NotifyBody;
	priority: Priority;
	status: Status;
	history: string[];
}

const PLAN: Record<NotifyBody['type'], readonly Channel[]> = {
	otp: ['push', 'sms'],
	like: ['push'],
	order: ['email'],
	marketing: ['email']
};

const PRIORITY: Record<NotifyBody['type'], Priority> = {
	otp: 'critical',
	order: 'normal',
	like: 'normal',
	marketing: 'bulk'
};

export class NotificationService {
	readonly notifications = new Map<number, Notification>();
	readonly byKey = new Map<string, number>();
	readonly devices = new Map<string, Set<string>>();
	readonly emails = new Map<string, string>();
	readonly preferences = new Map<string, Preferences>();
	readonly queues: Record<Priority, number[]> = { critical: [], normal: [], bulk: [] };
	readonly windows = new Map<string, { lead: number; members: number[]; until: number }>();
	readonly stats = { providerCalls: 0, sent: 0, staleTokensRemoved: 0, merged: 0 };
	private nextId = 1;

	constructor(
		private readonly provider: Provider,
		private readonly now: () => number,
		private readonly windowMs = 30_000
	) {}

	private log(n: Notification, line: string): void {
		n.history.push(`${new Date(this.now()).toISOString().slice(11, 19)} ${line}`);
	}

	accept(body: NotifyBody): { id: number; duplicate: boolean } {
		const key = `${body.userId}:${body.idempotencyKey}`;
		const existing = this.byKey.get(key);
		if (existing !== undefined) return { id: existing, duplicate: true };
		const n: Notification = {
			id: this.nextId++,
			body,
			priority: PRIORITY[body.type],
			status: { kind: 'queued' },
			history: []
		};
		this.notifications.set(n.id, n);
		this.byKey.set(key, n.id);
		this.log(n, `accepted (${n.priority})`);
		if (body.type === 'like') {
			const windowKey = `${body.userId}:like`;
			const open = this.windows.get(windowKey);
			if (open !== undefined) {
				open.members.push(n.id);
				n.status = { kind: 'merged', into: open.lead };
				this.stats.merged++;
				this.log(n, `merged into #${open.lead}`);
			} else {
				const until = this.now() + this.windowMs;
				this.windows.set(windowKey, { lead: n.id, members: [n.id], until });
				n.status = { kind: 'aggregating', until };
				this.log(n, `window open, ${this.windowMs / 1_000} s`);
			}
			return { id: n.id, duplicate: false };
		}
		this.queues[n.priority].push(n.id);
		return { id: n.id, duplicate: false };
	}

	private quiet(userId: string): number | undefined {
		const p = this.preferences.get(userId);
		if (p?.quietStart === undefined || p.quietEnd === undefined) return undefined;
		const date = new Date(this.now());
		const hour = date.getUTCHours();
		const inside =
			p.quietStart > p.quietEnd
				? hour >= p.quietStart || hour < p.quietEnd
				: hour >= p.quietStart && hour < p.quietEnd;
		if (!inside) return undefined;
		const end = new Date(date);
		end.setUTCHours(p.quietEnd, 0, 0, 0);
		if (end.getTime() <= this.now()) end.setUTCDate(end.getUTCDate() + 1);
		return end.getTime();
	}

	private text(n: Notification, extra: number): string {
		switch (n.body.type) {
			case 'otp':
				return `code: ${n.body.data['code'] ?? '------'}`;
			case 'order':
				return `order ${n.body.data['order'] ?? ''} has shipped`;
			case 'like':
				return extra > 0
					? `${n.body.data['from'] ?? 'someone'} and ${extra} others liked this`
					: `${n.body.data['from'] ?? 'someone'} liked this`;
			case 'marketing':
				return n.body.data['title'] ?? 'new offer';
		}
	}

	private deliver(n: Notification, extra = 0): void {
		const user = n.body.userId;
		if (n.body.type === 'marketing' && this.preferences.get(user)?.marketing === false) {
			n.status = { kind: 'suppressed', reason: 'marketing off' };
			this.log(n, 'skipped: the user has turned marketing off');
			return;
		}
		if (n.priority !== 'critical') {
			const until = this.quiet(user);
			if (until !== undefined) {
				n.status = { kind: 'deferred', until };
				this.log(n, `night-time quiet, until ${new Date(until).toISOString().slice(11, 16)}`);
				return;
			}
		}
		const text = this.text(n, extra);
		const key = `n-${n.id}`;
		let attempts = 0;
		for (const channel of PLAN[n.body.type]) {
			if (channel === 'push') {
				for (const token of [...(this.devices.get(user) ?? [])]) {
					attempts++;
					this.stats.providerCalls++;
					const result = this.provider.send('push', token, text, key);
					if (result.kind === 'unregistered') {
						this.devices.get(user)?.delete(token);
						this.stats.staleTokensRemoved++;
						this.log(n, `push: token ${token} dead, deleted`);
					} else if (result.kind === 'sent') {
						this.stats.sent++;
						n.status = { kind: 'sent', channel, attempts };
						this.log(n, `push sent (${token})`);
						return;
					}
				}
				continue;
			}
			const to = channel === 'sms' ? `phone:${user}` : this.emails.get(user);
			if (to === undefined) continue;
			for (let i = 0; i < 3; i++) {
				attempts++;
				this.stats.providerCalls++;
				const result = this.provider.send(channel, to, text, key);
				this.log(n, `${channel}: ${result.kind}`);
				if (result.kind === 'sent') {
					this.stats.sent++;
					n.status = { kind: 'sent', channel, attempts };
					return;
				}
			}
		}
		n.status = { kind: 'failed', reason: 'could not reach any channel' };
		this.log(n, 'failed');
	}

	tick(budget: number): number {
		let done = 0;
		for (const [key, w] of this.windows) {
			if (w.until > this.now()) continue;
			this.windows.delete(key);
			const lead = this.notifications.get(w.lead);
			if (lead !== undefined) this.deliver(lead, w.members.length - 1);
			done++;
		}
		for (const notification of this.notifications.values())
			if (notification.status.kind === 'deferred' && notification.status.until <= this.now()) {
				notification.status = { kind: 'queued' };
				this.queues[notification.priority].push(notification.id);
			}
		for (const priority of ['critical', 'normal', 'bulk'] as const) {
			const queue = this.queues[priority];
			while (done < budget && queue.length > 0) {
				const id = queue.shift();
				const n = id === undefined ? undefined : this.notifications.get(id);
				if (n !== undefined) this.deliver(n);
				done++;
			}
		}
		return done;
	}

	setPreferences(user: string, raw: unknown): boolean {
		const parsed = Preferences.safeParse(raw);
		if (!parsed.success) return false;
		this.preferences.set(user, parsed.data);
		return true;
	}
}

export function createApp(service: NotificationService): Express {
	const app = express();
	app.use(express.json({ limit: '8kb' }));
	app.post('/v1/notify', (req: Request, res: Response) => {
		const body = NotifyBody.safeParse(req.body);
		if (!body.success) {
			res.status(400).json({ error: 'invalid_body' });
			return;
		}
		res.status(202).json(service.accept(body.data));
	});
	app.put('/v1/users/:id/preferences', (req: Request<{ id: string }>, res: Response) => {
		if (!service.setPreferences(req.params.id, req.body)) {
			res.status(400).json({ error: 'invalid_body' });
			return;
		}
		res.status(204).end();
	});
	app.get('/v1/notifications/:id', (req: Request<{ id: string }>, res: Response) => {
		const n = service.notifications.get(Number(req.params.id));
		if (n === undefined) {
			res.status(404).json({ error: 'not_found' });
			return;
		}
		res.json({ id: n.id, status: n.status, history: n.history });
	});
	return app;
}
