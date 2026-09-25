import { latency } from './random';

// একটা ছোট discrete-event simulator: সময় আসলে চলে না, শুধু পরের event এর সময়ে লাফায়।
// তাই ১০ সেকেন্ডের cluster ১ ms এর কম সময়ে চলে, আর seed দেওয়া থাকায় প্রতিবার হুবহু একই।

export interface Timer {
	cancelled: boolean;
}

type Scheduled = { at: number; seq: number; timer: Timer; run: () => void };

export class Sim {
	now = 0;
	private seq = 0;
	private queue: Scheduled[] = [];

	schedule(delay: number, run: () => void): Timer {
		const timer: Timer = { cancelled: false };
		const item: Scheduled = { at: this.now + delay, seq: this.seq++, timer, run };
		// sorted insert — queue ছোট থাকে (কয়েক ডজন event), তাই heap এর দরকার নেই
		let i = this.queue.length;
		while (i > 0) {
			const prev = this.queue[i - 1];
			if (prev === undefined || prev.at < item.at || (prev.at === item.at && prev.seq < item.seq))
				break;
			i--;
		}
		this.queue.splice(i, 0, item);
		return timer;
	}

	// until পর্যন্ত সব event চালাও; stop() true দিলে আগেই থামো
	runUntil(until: number, stop: () => boolean = () => false): void {
		for (;;) {
			const next = this.queue[0];
			if (next === undefined || next.at > until) break;
			this.queue.shift();
			this.now = next.at;
			if (!next.timer.cancelled) next.run();
			if (stop()) return;
		}
		this.now = until;
	}
}

// Network: প্রতিটা message এর যাত্রার সময় random (seed দেওয়া), আর যেকোনো দুটো node এর মধ্যের
// link কাটা যায়। কাটা link এ message চুপচাপ হারায় — পাঠানো node কিছুই জানতে পারে না।
export class Network<M> {
	private cut = new Set<string>();
	private handlers = new Map<string, (message: M, from: string) => void>();

	constructor(
		private readonly sim: Sim,
		private readonly random: () => number,
		private readonly baseMs = 2,
		private readonly meanExtraMs = 2
	) {}

	register(id: string, handler: (message: M, from: string) => void): void {
		this.handlers.set(id, handler);
	}

	send(from: string, to: string, message: M): void {
		if (this.cut.has(`${from}|${to}`)) return;
		const delay = latency(this.random, this.baseMs, this.meanExtraMs);
		this.sim.schedule(delay, () => {
			// পৌঁছানোর মুহূর্তেও link কাটা থাকলে হারায়
			if (this.cut.has(`${from}|${to}`)) return;
			this.handlers.get(to)?.(message, from);
		});
	}

	// groups এর মধ্যে সব link কাটো — একই group এর ভেতরে কথা চলে
	partition(groups: string[][]): void {
		this.cut.clear();
		for (const a of groups)
			for (const b of groups) {
				if (a === b) continue;
				for (const x of a) for (const y of b) this.cut.add(`${x}|${y}`);
			}
	}

	heal(): void {
		this.cut.clear();
	}
}
