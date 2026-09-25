import type { Network, Sim, Timer } from './sim';

// Lesson 6.2 — Raft এর মূল অংশ: leader election, log replication, commit, election restriction।
// Raft paper (Ongaro & Ousterhout, 2014) এর Figure 2 এর নিয়ম, যতটা সম্ভব হুবহু।
// বাদ দেওয়া হয়েছে: membership change, snapshot, persistence (crash-recovery), PreVote, client session।
//
// Log index 1 থেকে শুরু (paper এর মতো): index i এর entry আছে log[i - 1] এ; index 0 মানে "খালি log"।

export type Entry = { term: number; command: string };

export type Message =
	| { type: 'RequestVote'; term: number; lastLogIndex: number; lastLogTerm: number }
	| { type: 'RequestVoteReply'; term: number; granted: boolean }
	| {
			type: 'AppendEntries';
			term: number;
			prevLogIndex: number;
			prevLogTerm: number;
			entries: Entry[];
			leaderCommit: number;
	  }
	| { type: 'AppendEntriesReply'; term: number; success: boolean; matchIndex: number };

// Role একটা discriminated union — leader এর nextIndex/matchIndex শুধু leader এর আছে,
// candidate এর votes শুধু candidate এর। Optional field এর জঙ্গল না।
type Role =
	| { kind: 'follower'; leaderId: string | null }
	| { kind: 'candidate'; votes: Set<string> }
	| { kind: 'leader'; nextIndex: Map<string, number>; matchIndex: Map<string, number> };

export type RaftEvent =
	| { kind: 'candidate'; node: string; term: number }
	| { kind: 'leader'; node: string; term: number }
	| { kind: 'step-down'; node: string; oldTerm: number; newTerm: number }
	| { kind: 'vote-rejected-log'; node: string; candidate: string; term: number }
	| { kind: 'commit'; node: string; term: number; index: number; command: string };

export interface RaftConfig {
	sim: Sim;
	network: Network<Message>;
	random: () => number;
	electionMinMs: number;
	electionMaxMs: number;
	heartbeatMs: number;
	// false হলে "election restriction" বন্ধ: log যত পুরনোই হোক, ভোট দেওয়া হয় — ইচ্ছা করে ভাঙা
	electionRestriction: boolean;
	onEvent: (event: RaftEvent) => void;
}

export class RaftNode {
	term = 0;
	votedFor: string | null = null;
	log: Entry[] = [];
	commitIndex = 0;
	role: Role = { kind: 'follower', leaderId: null };
	// state machine: commit হওয়া "key=value" command গুলো প্রয়োগ করে বানানো ছোট key-value store
	readonly kv = new Map<string, string>();
	private lastApplied = 0;
	private electionTimer: Timer | null = null;
	private heartbeatTimer: Timer | null = null;
	private rejectedLogged = new Set<string>();

	constructor(
		readonly id: string,
		private readonly peers: string[],
		private readonly config: RaftConfig
	) {
		config.network.register(id, (message, from) => this.handle(message, from));
	}

	start(): void {
		this.resetElectionTimer();
	}

	get isLeader(): boolean {
		return this.role.kind === 'leader';
	}

	lastLogIndex(): number {
		return this.log.length;
	}

	lastLogTerm(): number {
		return this.log[this.log.length - 1]?.term ?? 0;
	}

	// index এর entry এর term; index 0 → 0; entry না থাকলে undefined
	termAt(index: number): number | undefined {
		return index === 0 ? 0 : this.log[index - 1]?.term;
	}

	// client এর লেখা: শুধু leader নেয়। ফেরত দেয় entry এর index (commit এর নিশ্চয়তা না!)
	submit(command: string): { index: number; term: number } | null {
		if (this.role.kind !== 'leader') return null;
		this.log.push({ term: this.term, command });
		for (const peer of this.peers) this.sendAppend(peer);
		return { index: this.log.length, term: this.term };
	}

	private majority(): number {
		return Math.floor((this.peers.length + 1) / 2) + 1;
	}

	private send(to: string, message: Message): void {
		this.config.network.send(this.id, to, message);
	}

	// ── Timer ───────────────────────────────────────────────────────────────────

	private resetElectionTimer(): void {
		if (this.electionTimer) this.electionTimer.cancelled = true;
		const { electionMinMs: min, electionMaxMs: max, random } = this.config;
		// প্রতিবার নতুন random timeout (min–max), সাথে ±0.5 ms এর বাস্তব timer jitter
		const delay = min + random() * (max - min) + (random() - 0.5);
		this.electionTimer = this.config.sim.schedule(delay, () => this.startElection());
	}

	private startElection(): void {
		if (this.role.kind === 'leader') return;
		this.term += 1;
		this.votedFor = this.id;
		this.role = { kind: 'candidate', votes: new Set([this.id]) };
		this.config.onEvent({ kind: 'candidate', node: this.id, term: this.term });
		this.resetElectionTimer(); // এই election ও ব্যর্থ হলে (split vote) আবার চেষ্টা
		for (const peer of this.peers)
			this.send(peer, {
				type: 'RequestVote',
				term: this.term,
				lastLogIndex: this.lastLogIndex(),
				lastLogTerm: this.lastLogTerm()
			});
	}

	private becomeLeader(): void {
		const nextIndex = new Map<string, number>();
		const matchIndex = new Map<string, number>();
		for (const peer of this.peers) {
			nextIndex.set(peer, this.lastLogIndex() + 1);
			matchIndex.set(peer, 0);
		}
		this.role = { kind: 'leader', nextIndex, matchIndex };
		if (this.electionTimer) this.electionTimer.cancelled = true;
		this.config.onEvent({ kind: 'leader', node: this.id, term: this.term });
		this.heartbeat();
	}

	private heartbeat(): void {
		if (this.role.kind !== 'leader') return;
		for (const peer of this.peers) this.sendAppend(peer);
		this.heartbeatTimer = this.config.sim.schedule(this.config.heartbeatMs, () => this.heartbeat());
	}

	// নিজের চেয়ে বড় term দেখলে: term নাও, আর leader/candidate হলে follower হয়ে যাও
	private adoptTerm(term: number): void {
		const wasLeader = this.role.kind === 'leader';
		if (wasLeader)
			this.config.onEvent({ kind: 'step-down', node: this.id, oldTerm: this.term, newTerm: term });
		this.term = term;
		this.votedFor = null;
		if (this.role.kind !== 'follower') this.role = { kind: 'follower', leaderId: null };
		if (wasLeader) {
			if (this.heartbeatTimer) this.heartbeatTimer.cancelled = true;
			this.resetElectionTimer();
		}
	}

	// ── Message ─────────────────────────────────────────────────────────────────

	private handle(message: Message, from: string): void {
		// Raft এর সবচেয়ে গুরুত্বপূর্ণ নিয়ম: যেকোনো message এ বড় term দেখলেই নিজের term পুরনো
		if (message.term > this.term) this.adoptTerm(message.term);

		switch (message.type) {
			case 'RequestVote':
				return this.onRequestVote(message, from);
			case 'RequestVoteReply':
				return this.onRequestVoteReply(message, from);
			case 'AppendEntries':
				return this.onAppendEntries(message, from);
			case 'AppendEntriesReply':
				return this.onAppendEntriesReply(message, from);
		}
	}

	private onRequestVote(message: Extract<Message, { type: 'RequestVote' }>, from: string): void {
		// Election restriction: candidate এর log অন্তত আমার মতো নতুন হতে হবে —
		// শেষ entry এর term বড়, অথবা term সমান আর log অন্তত এত লম্বা
		const upToDate =
			message.lastLogTerm > this.lastLogTerm() ||
			(message.lastLogTerm === this.lastLogTerm() && message.lastLogIndex >= this.lastLogIndex());
		const logOk = this.config.electionRestriction ? upToDate : true;
		const granted =
			message.term === this.term && (this.votedFor === null || this.votedFor === from) && logOk;
		if (granted) {
			this.votedFor = from;
			this.resetElectionTimer();
		} else if (message.term === this.term && !upToDate) {
			const key = `${from}:${message.term}`;
			if (!this.rejectedLogged.has(key)) {
				this.rejectedLogged.add(key);
				this.config.onEvent({
					kind: 'vote-rejected-log',
					node: this.id,
					candidate: from,
					term: message.term
				});
			}
		}
		this.send(from, { type: 'RequestVoteReply', term: this.term, granted });
	}

	private onRequestVoteReply(
		message: Extract<Message, { type: 'RequestVoteReply' }>,
		from: string
	): void {
		if (this.role.kind !== 'candidate' || message.term !== this.term || !message.granted) return;
		this.role.votes.add(from);
		if (this.role.votes.size >= this.majority()) this.becomeLeader();
	}

	private onAppendEntries(
		message: Extract<Message, { type: 'AppendEntries' }>,
		from: string
	): void {
		const reply = (success: boolean, matchIndex: number): void =>
			this.send(from, { type: 'AppendEntriesReply', term: this.term, success, matchIndex });

		if (message.term < this.term) return reply(false, 0); // পুরনো leader — প্রত্যাখ্যান, সাথে আমার term

		// এই term এর বৈধ leader: candidate হলে পিছিয়ে যাও, election timer আবার শুরু
		this.role = { kind: 'follower', leaderId: from };
		this.resetElectionTimer();

		// আগের entry মেলে কিনা — না মিললে leader এক ধাপ পিছিয়ে আবার পাঠাবে
		if (this.termAt(message.prevLogIndex) !== message.prevLogTerm) return reply(false, 0);

		message.entries.forEach((entry, offset) => {
			const index = message.prevLogIndex + 1 + offset;
			const existing = this.termAt(index);
			if (existing !== undefined && existing !== entry.term) this.log.length = index - 1; // বিরোধ: এখান থেকে মুছে ফেলো
			if (index > this.log.length) this.log.push(entry);
		});

		const lastNew = message.prevLogIndex + message.entries.length;
		if (message.leaderCommit > this.commitIndex)
			this.commitIndex = Math.min(message.leaderCommit, lastNew);
		this.apply();
		reply(true, lastNew);
	}

	private onAppendEntriesReply(
		message: Extract<Message, { type: 'AppendEntriesReply' }>,
		from: string
	): void {
		if (this.role.kind !== 'leader' || message.term !== this.term) return;
		const { nextIndex, matchIndex } = this.role;
		if (message.success) {
			matchIndex.set(from, Math.max(matchIndex.get(from) ?? 0, message.matchIndex));
			nextIndex.set(from, (matchIndex.get(from) ?? 0) + 1);
			this.advanceCommit();
		} else {
			nextIndex.set(from, Math.max(1, (nextIndex.get(from) ?? 1) - 1));
			this.sendAppend(from);
		}
	}

	private sendAppend(peer: string): void {
		if (this.role.kind !== 'leader') return;
		const next = this.role.nextIndex.get(peer) ?? this.lastLogIndex() + 1;
		const prevLogIndex = next - 1;
		this.send(peer, {
			type: 'AppendEntries',
			term: this.term,
			prevLogIndex,
			prevLogTerm: this.termAt(prevLogIndex) ?? 0,
			entries: this.log.slice(prevLogIndex),
			leaderCommit: this.commitIndex
		});
	}

	// Commit rule: majority এর কাছে পৌঁছেছে, আর entry টা **এই term এর** — পুরনো term এর entry
	// শুধু গুনে commit করা নিরাপদ না (paper এর Figure 8); সেগুলো এই term এর entry এর সাথে commit হয়
	private advanceCommit(): void {
		if (this.role.kind !== 'leader') return;
		for (let n = this.lastLogIndex(); n > this.commitIndex; n--) {
			if (this.termAt(n) !== this.term) break;
			let count = 1; // নিজে
			for (const match of this.role.matchIndex.values()) if (match >= n) count++;
			if (count >= this.majority()) {
				this.commitIndex = n;
				this.apply();
				return;
			}
		}
	}

	private apply(): void {
		while (this.lastApplied < this.commitIndex) {
			this.lastApplied++;
			const entry = this.log[this.lastApplied - 1];
			if (entry === undefined) break;
			const [key, value] = entry.command.split('=');
			if (key !== undefined && value !== undefined) this.kv.set(key, value);
			if (this.role.kind === 'leader')
				this.config.onEvent({
					kind: 'commit',
					node: this.id,
					term: this.term,
					index: this.lastApplied,
					command: entry.command
				});
		}
	}
}
