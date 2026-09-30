export type Registration = { id: string; url: string; lastBeat: number };

export class Registry {
	readonly #entries = new Map<string, Registration>();
	readonly #ttlMs: number;

	constructor(ttlMs: number) {
		this.#ttlMs = ttlMs;
	}

	register(id: string, url: string, now: number): void {
		this.#entries.set(id, { id, url, lastBeat: now });
	}

	heartbeat(id: string, now: number): void {
		const entry = this.#entries.get(id);
		if (entry) entry.lastBeat = now;
	}

	deregister(id: string): void {
		this.#entries.delete(id);
	}

	alive(now: number): Registration[] {
		const live: Registration[] = [];
		for (const entry of this.#entries.values())
			if (now - entry.lastBeat <= this.#ttlMs) live.push(entry);
		return live;
	}

	all(): Registration[] {
		return [...this.#entries.values()];
	}
}

export class RoundRobin {
	#next = 0;

	pick(targets: readonly string[]): string | null {
		if (targets.length === 0) return null;
		const chosen = targets[this.#next % targets.length] ?? null;
		this.#next += 1;
		return chosen;
	}
}

export class Heartbeats {
	readonly #timers: NodeJS.Timeout[] = [];

	start(everyMs: number, beat: () => void): void {
		const timer = setInterval(beat, everyMs);
		timer.unref();
		this.#timers.push(timer);
	}

	stopAll(): void {
		for (const timer of this.#timers) clearInterval(timer);
		this.#timers.length = 0;
	}
}
