import { big, bytes, env, heading, n, row } from './util';

const DAU = env('DAU', 500_000_000);
const ONLINE_SHARE = env('ONLINE_SHARE', 0.3);
const MESSAGES_PER_USER = env('MESSAGES_PER_USER', 40);
const PEAK = env('PEAK', 3);
const GROUP_SHARE = env('GROUP_SHARE', 0.3);
const GROUP_SIZE = env('GROUP_SIZE', 20);
const CONN_BYTES = env('CONN_BYTES', 20_000);
const CONNS_PER_GATEWAY = env('CONNS_PER_GATEWAY', 500_000);
const HEARTBEAT_S = env('HEARTBEAT_S', 30);
const MESSAGE_BYTES = env('MESSAGE_BYTES', 200);
const YEARS = env('YEARS', 10);
const OFFLINE_SHARE = env('OFFLINE_SHARE', 0.5);
const OFFLINE_WAIT_H = env('OFFLINE_WAIT_H', 6);
const CONTACTS = env('CONTACTS', 200);
const TRANSITIONS = env('TRANSITIONS', 20);
const CHAT_OPEN_SHARE = env('CHAT_OPEN_SHARE', 0.01);

const DAY = 86_400;
const online = DAU * ONLINE_SHARE;
const perDay = DAU * MESSAGES_PER_USER;
const avg = perDay / DAY;
const peak = avg * PEAK;
const fanout = (1 - GROUP_SHARE) * 1 + GROUP_SHARE * (GROUP_SIZE - 1);

heading(`Part A — connections: ${big(DAU)} DAU, ${Math.round(ONLINE_SHARE * 100)}% online at peak`);
console.log(
	row([
		['', 52],
		['value', 18]
	]) + '   note'
);
const line = (label: string, value: string, note: string): void =>
	console.log(
		row([
			[label, 52],
			[value, 18]
		]) + (note === '' ? '' : `   ${note}`)
	);
line('connections open at once', big(online), 'each is a TCP + TLS + WebSocket');
line(
	`connection memory (${bytes(CONN_BYTES)} each, approximate)`,
	bytes(online * CONN_BYTES),
	'kernel buffers, TLS, app state'
);
line(
	`gateway servers (${n(CONNS_PER_GATEWAY)} connections each)`,
	n(Math.ceil(online / CONNS_PER_GATEWAY)),
	'when one dies, this many people reconnect at once'
);
line(`heartbeats / s (every ${HEARTBEAT_S} s)`, n(online / HEARTBEAT_S), 'more than the messages');

heading(
	`Part B — messages: ${MESSAGES_PER_USER} a day per user, ${Math.round(GROUP_SHARE * 100)}% in groups (${GROUP_SIZE} people on average)`
);
line('messages sent / s (average)', n(avg), `${big(perDay)} a day`);
line(`messages sent / s (peak, ${PEAK}×)`, n(peak), '');
line(
	'deliveries per message (fan-out)',
	fanout.toFixed(1),
	'each group member is a separate delivery'
);
line('delivery / s (peak)', n(peak * fanout), '');
line(
	'receipt (delivered + read) / s (peak)',
	n(peak * fanout * 2),
	'two from each delivery — more writes than messages'
);

heading(`Part C — storage: ${MESSAGE_BYTES} B per message`);
const forever = perDay * MESSAGE_BYTES * 365 * YEARS;
const pending = (peak / PEAK) * fanout * OFFLINE_SHARE * OFFLINE_WAIT_H * 3_600 * MESSAGE_BYTES;
line('new per day', bytes(perDay * MESSAGE_BYTES), '');
line(
	`all history forever (${YEARS} years, one copy)`,
	bytes(forever),
	'history on the server (like Messenger/Slack)'
);
line(
	'only undelivered messages (deleted once delivered)',
	bytes(pending),
	`${Math.round(OFFLINE_SHARE * 100)}% of deliveries wait ${OFFLINE_WAIT_H} hours on average`
);
line('difference', `${n(forever / pending)} times`, 'a product decision, not a storage one');

heading(
	`Part D — presence: ${CONTACTS} contacts on average, online ↔ offline ${TRANSITIONS} times a day`
);
const transitions = (DAU * TRANSITIONS) / DAY;
line('online/offline changes / s', n(transitions), '');
line('push to every contact / s', n(transitions * CONTACTS), 'presence storm');
line(
	`only those with the chat open (${Math.round(CHAT_OPEN_SHARE * 100)}%) / s`,
	n(transitions * CONTACTS * CHAT_OPEN_SHARE),
	'lazy presence: only if subscribed'
);
