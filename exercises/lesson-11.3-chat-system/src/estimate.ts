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

heading(`অংশ ক — connection: ${big(DAU)} DAU, peak এ ${Math.round(ONLINE_SHARE * 100)}% online`);
console.log(
	row([
		['', 52],
		['মান', 18]
	]) + '   মন্তব্য'
);
const line = (label: string, value: string, note: string): void =>
	console.log(
		row([
			[label, 52],
			[value, 18]
		]) + (note === '' ? '' : `   ${note}`)
	);
line('একসাথে খোলা connection', big(online), 'প্রতিটা একটা TCP + TLS + WebSocket');
line(
	`connection এর memory (${bytes(CONN_BYTES)} প্রতিটা, আনুমানিক)`,
	bytes(online * CONN_BYTES),
	'kernel buffer, TLS, app এর অবস্থা'
);
line(
	`gateway server (${n(CONNS_PER_GATEWAY)} connection প্রতিটা)`,
	n(Math.ceil(online / CONNS_PER_GATEWAY)),
	'একটা মরলে এতগুলো মানুষ একসাথে reconnect করে'
);
line(`heartbeat / s (প্রতি ${HEARTBEAT_S} s এ)`, n(online / HEARTBEAT_S), 'message এর চেয়েও বেশি');

heading(
	`অংশ খ — message: দিনে user প্রতি ${MESSAGES_PER_USER}টা, ${Math.round(GROUP_SHARE * 100)}% group এ (গড়ে ${GROUP_SIZE} জন)`
);
line('পাঠানো message / s (গড়)', n(avg), `দিনে ${big(perDay)}`);
line(`পাঠানো message / s (peak, ${PEAK}×)`, n(peak), '');
line(
	'প্রতি message এ পৌঁছানো (fan-out)',
	fanout.toFixed(1),
	'group এর প্রতিটা সদস্য একটা আলাদা delivery'
);
line('delivery / s (peak)', n(peak * fanout), '');
line(
	'receipt (delivered + read) / s (peak)',
	n(peak * fanout * 2),
	'প্রতিটা delivery থেকে দুটো — message এর চেয়ে বেশি লেখা'
);

heading(`অংশ গ — storage: message প্রতি ${MESSAGE_BYTES} B`);
const forever = perDay * MESSAGE_BYTES * 365 * YEARS;
const pending = (peak / PEAK) * fanout * OFFLINE_SHARE * OFFLINE_WAIT_H * 3_600 * MESSAGE_BYTES;
line('প্রতিদিন নতুন', bytes(perDay * MESSAGE_BYTES), '');
line(
	`সব history চিরকাল (${YEARS} বছর, এক কপি)`,
	bytes(forever),
	'server এ history (Messenger/Slack এর মতো)'
);
line(
	'শুধু না-পৌঁছানো message (পৌঁছালে মুছে ফেলা)',
	bytes(pending),
	`${Math.round(OFFLINE_SHARE * 100)}% delivery গড়ে ${OFFLINE_WAIT_H} ঘণ্টা অপেক্ষা করে`
);
line('পার্থক্য', `${n(forever / pending)} গুণ`, 'একটা product এর সিদ্ধান্ত, storage এর না');

heading(`অংশ ঘ — presence: গড়ে ${CONTACTS} contact, দিনে ${TRANSITIONS} বার online ↔ offline`);
const transitions = (DAU * TRANSITIONS) / DAY;
line('online/offline বদল / s', n(transitions), '');
line('সব contact কে push / s', n(transitions * CONTACTS), 'presence storm');
line(
	`শুধু যাদের chat খোলা (${Math.round(CHAT_OPEN_SHARE * 100)}%) / s`,
	n(transitions * CONTACTS * CHAT_OPEN_SHARE),
	'lazy presence: subscribe করলে তবেই'
);
