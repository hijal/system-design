import { untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

const STORAGE_KEY = 'course-progress-v1';

type ProgressData = { completed: string[]; lastVisited: string | null };

function isProgressData(value: unknown): value is ProgressData {
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray((value as ProgressData).completed) &&
		(value as ProgressData).completed.every((id) => typeof id === 'string') &&
		((value as ProgressData).lastVisited === null ||
			typeof (value as ProgressData).lastVisited === 'string')
	);
}

function read(): ProgressData | null {
	let raw: string | null;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
	if (!raw) return { completed: [], lastVisited: null };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isProgressData(parsed)) return parsed;
	} catch {
		// corrupt or inaccessible storage (private mode) - fall back to empty progress
	}
	return { completed: [], lastVisited: null };
}

function write(data: ProgressData): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
	} catch {
		// storage unavailable or full - progress simply won't persist this session
	}
}

// Starts empty on both server and client so the first client render matches the SSR HTML;
// the layout calls load() after mount to pull in the saved progress.
export class ProgressStore {
	completed = new SvelteSet<string>();
	lastVisited = $state<string | null>(null);
	#loaded = false;

	load(): void {
		if (this.#loaded) return;
		this.#loaded = true;
		this.#sync();
		if (typeof window !== 'undefined')
			window.addEventListener('storage', (event) => {
				if (event.key === STORAGE_KEY || event.key === null) this.#sync();
			});
	}

	#sync(): void {
		const saved = read();
		if (!saved) return;
		for (const id of this.completed) if (!saved.completed.includes(id)) this.completed.delete(id);
		for (const id of saved.completed) this.completed.add(id);
		this.lastVisited = saved.lastVisited ?? this.lastVisited;
	}

	isCompleted(id: string): boolean {
		return this.completed.has(id);
	}

	toggle(id: string): void {
		untrack(() => {
			this.load();
			this.#sync();
			if (this.completed.has(id)) this.completed.delete(id);
			else this.completed.add(id);
			write({ completed: [...this.completed], lastVisited: this.lastVisited });
		});
	}

	visit(id: string): void {
		untrack(() => {
			this.load();
			this.#sync();
			if (this.lastVisited === id) return;
			this.lastVisited = id;
			write({ completed: [...this.completed], lastVisited: id });
		});
	}
}

// Named courseProgress, not progress - Toc.svelte already has an unrelated scroll-% "progress".
export const courseProgress = new ProgressStore();
