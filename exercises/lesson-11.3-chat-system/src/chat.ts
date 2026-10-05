import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

export const ClientFrame = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('send'),
		conv: z.string().min(1),
		clientMsgId: z.string().min(1).max(64),
		text: z.string().min(1).max(4_000)
	}),
	z.object({ type: z.literal('delivered'), conv: z.string(), seq: z.number().int().positive() }),
	z.object({ type: z.literal('read'), conv: z.string(), seq: z.number().int().positive() }),
	z.object({ type: z.literal('sync'), cursors: z.record(z.string(), z.number().int().min(0)) })
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const Message = z.object({
	conv: z.string(),
	seq: z.number().int(),
	from: z.string(),
	clientMsgId: z.string(),
	text: z.string()
});
export type Message = z.infer<typeof Message>;

export const ServerFrame = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('ack'),
		clientMsgId: z.string(),
		seq: z.number(),
		duplicate: z.boolean()
	}),
	z.object({ type: z.literal('message'), message: Message }),
	z.object({
		type: z.literal('receipt'),
		conv: z.string(),
		seq: z.number(),
		by: z.string(),
		kind: z.enum(['delivered', 'read'])
	}),
	z.object({ type: z.literal('synced'), messages: z.array(Message) }),
	z.object({ type: z.literal('error'), error: z.string() })
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

interface Conversation {
	members: readonly string[];
	log: Message[];
	byClientId: Map<string, number>;
}

export class ChatCore {
	readonly registry = new Map<string, string>();
	readonly gateways = new Map<string, Gateway>();
	readonly conversations = new Map<string, Conversation>();
	readonly stats = {
		stored: 0,
		duplicates: 0,
		crossGateway: 0,
		sameGateway: 0,
		offlinePush: 0,
		staleRoute: 0
	};

	createConversation(id: string, members: readonly string[]): void {
		this.conversations.set(id, { members, log: [], byClientId: new Map() });
	}

	accept(
		from: string,
		conv: string,
		clientMsgId: string,
		text: string
	): { seq: number; duplicate: boolean } | undefined {
		const c = this.conversations.get(conv);
		if (c === undefined || !c.members.includes(from)) return undefined;
		const dedupeKey = `${from}:${clientMsgId}`;
		const existing = c.byClientId.get(dedupeKey);
		if (existing !== undefined) {
			this.stats.duplicates++;
			return { seq: existing, duplicate: true };
		}
		const message: Message = { conv, seq: c.log.length + 1, from, clientMsgId, text };
		c.log.push(message);
		c.byClientId.set(dedupeKey, message.seq);
		this.stats.stored++;
		return { seq: message.seq, duplicate: false };
	}

	send(user: string, frame: ServerFrame, fromGateway: string): boolean {
		const gatewayId = this.registry.get(user);
		if (gatewayId === undefined) return false;
		const gateway = this.gateways.get(gatewayId);
		if (gateway === undefined || !gateway.push(user, frame)) {
			this.stats.staleRoute++;
			return false;
		}
		if (gatewayId === fromGateway) this.stats.sameGateway++;
		else this.stats.crossGateway++;
		return true;
	}

	fanOut(conv: string, seq: number, fromGateway: string): void {
		const c = this.conversations.get(conv);
		const message = c?.log[seq - 1];
		if (c === undefined || message === undefined) return;
		for (const member of c.members) {
			if (member === message.from) continue;
			if (!this.send(member, { type: 'message', message }, fromGateway)) this.stats.offlinePush++;
		}
	}

	receipt(
		by: string,
		conv: string,
		seq: number,
		kind: 'delivered' | 'read',
		fromGateway: string
	): void {
		const message = this.conversations.get(conv)?.log[seq - 1];
		if (message === undefined) return;
		this.send(message.from, { type: 'receipt', conv, seq, by, kind }, fromGateway);
	}

	since(user: string, cursors: Record<string, number>): Message[] {
		const out: Message[] = [];
		for (const [id, c] of this.conversations) {
			if (!c.members.includes(user)) continue;
			out.push(...c.log.slice(cursors[id] ?? 0).filter((m) => m.from !== user));
		}
		return out;
	}
}

export class Gateway {
	private readonly sockets = new Map<string, WebSocket>();
	private readonly server: Server;
	private readonly wss: WebSocketServer;
	alive = true;

	constructor(
		readonly id: string,
		private readonly core: ChatCore
	) {
		this.server = createServer();
		this.wss = new WebSocketServer({ server: this.server });
		this.wss.on('connection', (socket: WebSocket, req: IncomingMessage) =>
			this.attach(socket, req)
		);
		core.gateways.set(id, this);
	}

	listen(): Promise<number> {
		return new Promise((resolve) => {
			this.server.listen(0, () => {
				const address = this.server.address();
				resolve(address !== null && typeof address !== 'string' ? address.port : 0);
			});
		});
	}

	private attach(socket: WebSocket, req: IncomingMessage): void {
		const user = new URL(req.url ?? '/', 'http://gateway').searchParams.get('user');
		if (user === null || user === '') {
			socket.close(1008, 'user required');
			return;
		}
		this.sockets.set(user, socket);
		this.core.registry.set(user, this.id);
		socket.on('message', (data) => this.handle(user, socket, data.toString()));
		socket.on('close', () => {
			if (this.sockets.get(user) === socket) this.sockets.delete(user);
			if (this.core.registry.get(user) === this.id && this.alive) this.core.registry.delete(user);
		});
	}

	private reply(socket: WebSocket, frame: ServerFrame): void {
		socket.send(JSON.stringify(frame));
	}

	private handle(user: string, socket: WebSocket, raw: string): void {
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			this.reply(socket, { type: 'error', error: 'invalid_json' });
			return;
		}
		const frame = ClientFrame.safeParse(json);
		if (!frame.success) {
			this.reply(socket, { type: 'error', error: 'invalid_frame' });
			return;
		}
		const f = frame.data;
		switch (f.type) {
			case 'send': {
				const result = this.core.accept(user, f.conv, f.clientMsgId, f.text);
				if (result === undefined) {
					this.reply(socket, { type: 'error', error: 'not_a_member' });
					return;
				}
				this.reply(socket, { type: 'ack', clientMsgId: f.clientMsgId, ...result });
				if (!result.duplicate) this.core.fanOut(f.conv, result.seq, this.id);
				return;
			}
			case 'delivered':
			case 'read':
				this.core.receipt(user, f.conv, f.seq, f.type, this.id);
				return;
			case 'sync':
				this.reply(socket, { type: 'synced', messages: this.core.since(user, f.cursors) });
				return;
		}
	}

	push(user: string, frame: ServerFrame): boolean {
		const socket = this.sockets.get(user);
		if (!this.alive || socket === undefined || socket.readyState !== socket.OPEN) return false;
		socket.send(JSON.stringify(frame));
		return true;
	}

	crash(): void {
		this.alive = false;
		for (const socket of this.sockets.values()) socket.terminate();
		this.sockets.clear();
		this.server.close();
	}

	close(): Promise<void> {
		this.alive = false;
		for (const socket of this.sockets.values()) socket.close();
		return new Promise((resolve) => {
			this.wss.close(() => this.server.close(() => resolve()));
		});
	}
}
