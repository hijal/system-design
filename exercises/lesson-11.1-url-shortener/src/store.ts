import { createHash } from 'node:crypto';
import { encode, keyspace } from './base62';
import { Permutation } from './scramble';

export const CODE_LENGTH = 7;

export type LinkState = { kind: 'active' } | { kind: 'disabled'; reason: string; at: number };

export interface Link {
	code: string;
	url: string;
	custom: boolean;
	createdAt: number;
	expiresAt: number | null;
	state: LinkState;
}

export type Resolution =
	| { kind: 'redirect'; url: string }
	| { kind: 'missing' }
	| { kind: 'expired' }
	| { kind: 'disabled' };

export interface LinkStore {
	insert(link: Link): 'ok' | 'taken';
	get(code: string): Link | undefined;
	disable(code: string, reason: string, at: number): boolean;
	size(): number;
}

export class MemoryLinkStore implements LinkStore {
	private readonly links = new Map<string, Link>();

	insert(link: Link): 'ok' | 'taken' {
		if (this.links.has(link.code)) return 'taken';
		this.links.set(link.code, link);
		return 'ok';
	}

	get(code: string): Link | undefined {
		return this.links.get(code);
	}

	disable(code: string, reason: string, at: number): boolean {
		const link = this.links.get(code);
		if (link === undefined) return false;
		link.state = { kind: 'disabled', reason, at };
		return true;
	}

	size(): number {
		return this.links.size;
	}
}

export function resolve(link: Link | undefined, now: number): Resolution {
	if (link === undefined) return { kind: 'missing' };
	if (link.state.kind === 'disabled') return { kind: 'disabled' };
	if (link.expiresAt !== null && link.expiresAt <= now) return { kind: 'expired' };
	return { kind: 'redirect', url: link.url };
}

export class CountingSequence {
	calls = 0;
	private next = 1;

	reserve(size: number): number {
		this.calls++;
		const start = this.next;
		this.next += size;
		return start;
	}
}

export class RangeAllocator {
	private next = 0;
	private end = 0;

	constructor(
		private readonly sequence: CountingSequence,
		private readonly blockSize: number
	) {}

	nextId(): number {
		if (this.next >= this.end) {
			this.next = this.sequence.reserve(this.blockSize);
			this.end = this.next + this.blockSize;
		}
		return this.next++;
	}
}

export class CodeGenerator {
	private readonly permutation: Permutation;

	constructor(
		private readonly allocator: RangeAllocator,
		secret: number
	) {
		this.permutation = new Permutation(keyspace(CODE_LENGTH), secret);
	}

	next(): string {
		return encode(this.permutation.apply(this.allocator.nextId()), CODE_LENGTH);
	}
}

interface ClickEvent {
	code: string;
	visitor: string;
	at: number;
}

export interface LinkStats {
	clicks: number;
	uniqueVisitors: number;
}

export class ClickBuffer {
	private pending: ClickEvent[] = [];
	private readonly totals = new Map<string, { clicks: number; visitors: Set<string> }>();
	flushes = 0;

	record(code: string, visitorKey: string, at: number): void {
		const visitor = createHash('sha256').update(visitorKey).digest('hex').slice(0, 16);
		this.pending.push({ code, visitor, at });
	}

	pendingCount(): number {
		return this.pending.length;
	}

	flush(): number {
		const batch = this.pending;
		this.pending = [];
		for (const event of batch) {
			const entry = this.totals.get(event.code) ?? { clicks: 0, visitors: new Set<string>() };
			entry.clicks++;
			entry.visitors.add(event.visitor);
			this.totals.set(event.code, entry);
		}
		if (batch.length > 0) this.flushes++;
		return batch.length;
	}

	stats(code: string): LinkStats {
		const entry = this.totals.get(code);
		return { clicks: entry?.clicks ?? 0, uniqueVisitors: entry?.visitors.size ?? 0 };
	}
}
