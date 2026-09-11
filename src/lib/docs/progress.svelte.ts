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

function read(): ProgressData {
	if (typeof localStorage === 'undefined') return { completed: [], lastVisited: null };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { completed: [], lastVisited: null };
		const parsed: unknown = JSON.parse(raw);
		if (isProgressData(parsed)) return parsed;
	} catch {
		// corrupt or inaccessible storage (private mode) — fall back to empty progress
	}
	return { completed: [], lastVisited: null };
}

function write(data: ProgressData): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
	} catch {
		// storage unavailable or full — progress simply won't persist this session
	}
}

const initial = read();

class ProgressStore {
	completed = new SvelteSet<string>(initial.completed);
	lastVisited = $state<string | null>(initial.lastVisited);

	isCompleted(id: string): boolean {
		return this.completed.has(id);
	}

	toggle(id: string): void {
		if (this.completed.has(id)) this.completed.delete(id);
		else this.completed.add(id);
		write({ completed: [...this.completed], lastVisited: this.lastVisited });
	}

	visit(id: string): void {
		if (this.lastVisited === id) return;
		this.lastVisited = id;
		write({ completed: [...this.completed], lastVisited: id });
	}
}

// Named courseProgress, not progress — Toc.svelte already has an unrelated scroll-% "progress".
export const courseProgress = new ProgressStore();
