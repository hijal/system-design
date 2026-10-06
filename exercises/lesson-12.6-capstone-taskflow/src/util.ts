import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';

export const n = (value: number): string => Math.round(value).toLocaleString('en-US');

export const padEnd = (value: string | number, width: number): string => {
	const text = String(value);
	return text + ' '.repeat(Math.max(2, width - [...text].length));
};

export const padLeft = (value: string | number, width: number): string => {
	const text = String(value);
	return ' '.repeat(Math.max(2, width - [...text].length)) + text;
};

export function row(columns: [string | number, number][]): string {
	return columns
		.map(([value, width], index) => (index === 0 ? padEnd(value, width) : padLeft(value, width)))
		.join('');
}

export function heading(title: string): void {
	console.log(`\n── ${title} ──`);
}

export const env = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
	return value;
};

export function fmix32(input: number): number {
	let h = input >>> 0;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

export const chance = (id: number, seed: number, rate: number): boolean =>
	fmix32(id ^ Math.imul(seed, 0x9e3779b1)) / 4294967296 < rate;

export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
}

export async function listen(app: Express): Promise<{ server: Server; base: string }> {
	return new Promise((resolve, reject) => {
		const server = app.listen(0, () => {
			const address: AddressInfo | string | null = server.address();
			if (address === null || typeof address === 'string') {
				reject(new Error('the server has no TCP address'));
				return;
			}
			resolve({ server, base: `http://127.0.0.1:${address.port}` });
		});
	});
}

export async function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);
}

export type HttpResult = { status: number; body: unknown; headers: Headers };

export async function http(
	base: string,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {}
): Promise<HttpResult> {
	const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...headers } };
	if (body !== undefined) init.body = JSON.stringify(body);
	const response = await fetch(`${base}${path}`, init);
	return { status: response.status, body: await response.json(), headers: response.headers };
}
