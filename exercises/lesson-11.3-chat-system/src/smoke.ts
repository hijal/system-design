import { WebSocket } from 'ws';
import { ChatCore, type ClientFrame, Gateway, ServerFrame } from './chat';
import { heading, padEnd } from './util';

class Client {
	readonly frames: ServerFrame[] = [];
	private socket: WebSocket | undefined;

	constructor(readonly user: string) {}

	connect(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(`ws://127.0.0.1:${port}/?user=${this.user}`);
			socket.on('message', (data) => {
				const frame = ServerFrame.safeParse(JSON.parse(data.toString()));
				if (frame.success) {
					this.frames.push(frame.data);
					if (frame.data.type === 'message') {
						const { conv, seq } = frame.data.message;
						this.send({ type: 'delivered', conv, seq });
					}
				}
			});
			socket.once('open', () => resolve());
			socket.once('error', reject);
			this.socket = socket;
		});
	}

	send(frame: ClientFrame): void {
		this.socket?.send(JSON.stringify(frame));
	}

	async waitFor<T extends ServerFrame>(match: (f: ServerFrame) => f is T, count = 1): Promise<T[]> {
		for (let i = 0; i < 200; i++) {
			const found = this.frames.filter(match);
			if (found.length >= count) return found;
			await new Promise((r) => setTimeout(r, 5));
		}
		throw new Error(`${this.user}: timed out waiting, no frame arrived`);
	}

	messages(conv: string): string[] {
		const seen = new Map<number, string>();
		for (const f of this.frames) {
			if (f.type === 'message' && f.message.conv === conv) seen.set(f.message.seq, f.message.text);
			if (f.type === 'synced')
				for (const m of f.messages) if (m.conv === conv) seen.set(m.seq, m.text);
		}
		return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([seq, text]) => `${seq}:${text}`);
	}

	close(): void {
		this.socket?.close();
	}
}

const isAck = (f: ServerFrame): f is Extract<ServerFrame, { type: 'ack' }> => f.type === 'ack';
const isMessage = (f: ServerFrame): f is Extract<ServerFrame, { type: 'message' }> =>
	f.type === 'message';
const isReceipt = (f: ServerFrame): f is Extract<ServerFrame, { type: 'receipt' }> =>
	f.type === 'receipt';
const isSynced = (f: ServerFrame): f is Extract<ServerFrame, { type: 'synced' }> =>
	f.type === 'synced';
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

let step = 0;
const show = (what: string, result: string): void => {
	step++;
	console.log(padEnd(step, 4) + padEnd(what, 64) + result);
};

async function main(): Promise<void> {
	const core = new ChatCore();
	core.createConversation('dm', ['alice', 'bob']);
	core.createConversation('team', ['alice', 'bob', 'carol']);
	const gw1 = new Gateway('gw1', core);
	const gw2 = new Gateway('gw2', core);
	const [p1, p2] = await Promise.all([gw1.listen(), gw2.listen()]);

	const alice = new Client('alice');
	const bob = new Client('bob');
	const carol = new Client('carol');
	await alice.connect(p1);
	await bob.connect(p2);

	heading(
		'two gateways (gw1, gw2), one chat core (registry + store); alice on gw1, bob on gw2, carol offline'
	);
	console.log(padEnd('#', 4) + padEnd('step', 64) + 'result');

	alice.send({ type: 'send', conv: 'dm', clientMsgId: 'a-1', text: 'hi' });
	const [ack] = await alice.waitFor(isAck);
	show('alice → bob: "hi"', `ack seq ${ack?.seq} (✓ durable on the server)`);
	await bob.waitFor(isMessage);
	show('bob received it (on gw2, via the registry)', bob.messages('dm').join(', '));
	await alice.waitFor(isReceipt);
	show('bob\'s phone sends "delivered" automatically', 'alice got receipt: delivered (✓✓)');
	bob.send({ type: 'read', conv: 'dm', seq: 1 });
	await alice.waitFor(isReceipt, 2);
	show('bob read it', 'alice got receipt: read (blue ✓✓)');

	alice.send({ type: 'send', conv: 'dm', clientMsgId: 'a-1', text: 'hi' });
	const acks = await alice.waitFor(isAck, 2);
	await settle();
	show(
		'alice resent the same client_msg_id (as if the ack was lost)',
		`ack seq ${acks[1]?.seq}, duplicate: ${String(acks[1]?.duplicate)}; ${bob.messages('dm').length} at bob`
	);

	for (const text of ['standup?', 'at 10', 'ok'])
		alice.send({ type: 'send', conv: 'team', clientMsgId: `a-${text}`, text });
	await bob.waitFor(isMessage, 4);
	show(
		'alice → team, 3 messages, carol offline',
		`bob: ${bob.messages('team').join(', ')}; offline push: ${core.stats.offlinePush}`
	);

	await carol.connect(p1);
	carol.send({ type: 'sync', cursors: {} });
	await carol.waitFor(isSynced);
	show('carol online (gw1), sync { }', carol.messages('team').join(', '));

	gw2.crash();
	await settle();
	alice.send({ type: 'send', conv: 'dm', clientMsgId: 'a-2', text: 'you there?' });
	alice.send({ type: 'send', conv: 'dm', clientMsgId: 'a-3', text: 'call me' });
	await alice.waitFor(isAck, 4 + 2);
	await settle();
	show(
		'gw2 crashes; alice → bob 2 messages (registry still gw2)',
		`stale route: ${core.stats.staleRoute}, ${core.conversations.get('dm')?.log.length ?? 0} in dm in the store`
	);
	const bob2 = new Client('bob');
	await bob2.connect(p1);
	bob2.send({ type: 'sync', cursors: { dm: 1, team: 3 } });
	await bob2.waitFor(isSynced);
	show('bob reconnects on gw1, sync { dm: 1, team: 3 }', bob2.messages('dm').join(', '));

	alice.send({ type: 'send', conv: 'team', clientMsgId: 'a-x', text: 'me first' });
	bob2.send({ type: 'send', conv: 'team', clientMsgId: 'b-x', text: 'no, me' });
	await carol.waitFor(isMessage, 2);
	await settle();
	const carolView = carol.messages('team').slice(-2).join(', ');
	const tail = (c: Client): string[] =>
		c.frames
			.filter(isAck)
			.filter((a) => a.clientMsgId === 'a-x' || a.clientMsgId === 'b-x')
			.map((a) => String(a.seq));
	show(
		'alice and bob in team at the same time',
		`carol sees: ${carolView}; seq: ${[...tail(alice), ...tail(bob2)].sort().join(', ')}`
	);

	show(
		"the core's counts",
		`stored ${core.stats.stored}, duplicate ${core.stats.duplicates}, other gateway ${core.stats.crossGateway}, same gateway ${core.stats.sameGateway}`
	);

	for (const c of [alice, bob2, carol]) c.close();
	await Promise.all([gw1.close()]);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
