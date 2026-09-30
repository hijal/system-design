import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressStore } from './progress.svelte';

const STORAGE_KEY = 'course-progress-v1';

class MemoryStorage {
	readonly #data = new Map<string, string>();
	throwOnWrite = false;
	get length(): number {
		return this.#data.size;
	}
	clear(): void {
		this.#data.clear();
	}
	getItem(key: string): string | null {
		return this.#data.get(key) ?? null;
	}
	key(index: number): string | null {
		return [...this.#data.keys()][index] ?? null;
	}
	removeItem(key: string): void {
		this.#data.delete(key);
	}
	setItem(key: string, value: string): void {
		if (this.throwOnWrite) throw new DOMException('QuotaExceededError');
		this.#data.set(key, value);
	}
}

let storage: MemoryStorage;

beforeEach(() => {
	storage = new MemoryStorage();
	vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('course progress', () => {
	it('starts empty before load so the first client render matches the SSR HTML', () => {
		storage.setItem(STORAGE_KEY, JSON.stringify({ completed: ['1.1'], lastVisited: '1.1' }));
		const store = new ProgressStore();
		expect(store.isCompleted('1.1')).toBe(false);
		expect(store.lastVisited).toBe(null);
		store.load();
		expect(store.isCompleted('1.1')).toBe(true);
		expect(store.lastVisited).toBe('1.1');
	});

	it('persists a toggle so a later store reads it back', () => {
		const store = new ProgressStore();
		store.toggle('9.3');
		expect(store.isCompleted('9.3')).toBe(true);

		const reloaded = new ProgressStore();
		reloaded.load();
		expect(reloaded.isCompleted('9.3')).toBe(true);

		store.toggle('9.3');
		const afterUntoggle = new ProgressStore();
		afterUntoggle.load();
		expect(afterUntoggle.isCompleted('9.3')).toBe(false);
	});

	it('keeps completed lessons when recording a visit', () => {
		const store = new ProgressStore();
		store.toggle('5.5');
		store.visit('6.1');

		const reloaded = new ProgressStore();
		reloaded.load();
		expect(reloaded.lastVisited).toBe('6.1');
		expect(reloaded.isCompleted('5.5')).toBe(true);
	});

	it.each([
		['corrupt JSON', '{not json'],
		['wrong shape', JSON.stringify({ completed: 'all', lastVisited: null })],
		['non-string ids', JSON.stringify({ completed: [1, 2], lastVisited: null })],
		['wrong lastVisited type', JSON.stringify({ completed: [], lastVisited: 7 })]
	])('falls back to empty progress on %s', (_label, stored) => {
		storage.setItem(STORAGE_KEY, stored);
		const store = new ProgressStore();
		expect(() => store.load()).not.toThrow();
		expect([...store.completed]).toEqual([]);
		expect(store.lastVisited).toBe(null);
	});

	it('still tracks progress in memory when storage is unavailable', () => {
		vi.stubGlobal('localStorage', undefined);
		const store = new ProgressStore();
		expect(() => store.toggle('7.4')).not.toThrow();
		expect(store.isCompleted('7.4')).toBe(true);
	});

	it('does not surface a write failure to the caller', () => {
		storage.throwOnWrite = true;
		const store = new ProgressStore();
		expect(() => store.toggle('8.2')).not.toThrow();
		expect(store.isCompleted('8.2')).toBe(true);
	});
});
