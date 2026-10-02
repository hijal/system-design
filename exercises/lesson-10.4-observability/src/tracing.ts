import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { mulberry32 } from './random';

export type SpanContext = { traceId: string; spanId: string; sampled: boolean };

export type Span = {
	traceId: string;
	spanId: string;
	parentId: string | null;
	service: string;
	name: string;
	start: number;
	end: number;
	attributes: Record<string, string | number>;
	status: 'ok' | 'error';
};

export type LogLine = {
	ms: number;
	level: 'info' | 'warn' | 'error';
	service: string;
	trace_id: string | null;
	span_id: string | null;
	msg: string;
} & Record<string, string | number | null>;

type Active = SpanContext & { service: string; span: Span };

const storage = new AsyncLocalStorage<Active>();
const random = mulberry32(Number(process.env.SEED ?? 7));
const origin = performance.now();

export const spans: Span[] = [];
export const logs: LogLine[] = [];

const hex = (length: number): string => {
	let out = '';
	while (out.length < length)
		out += Math.floor(random() * 0x1_0000_0000)
			.toString(16)
			.padStart(8, '0');
	return out.slice(0, length);
};

const now = (): number => performance.now() - origin;

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(header: string | string[] | undefined): SpanContext | null {
	if (typeof header !== 'string') return null;
	const match = TRACEPARENT.exec(header);
	if (!match?.[1] || !match[2] || !match[3]) return null;
	return { traceId: match[1], spanId: match[2], sampled: (parseInt(match[3], 16) & 1) === 1 };
}

export function formatTraceparent(context: SpanContext): string {
	return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

export function current(): Active | undefined {
	return storage.getStore();
}

export async function withSpan<T>(
	service: string,
	name: string,
	parent: SpanContext | null,
	attributes: Record<string, string | number>,
	work: (span: Span) => Promise<T>
): Promise<T> {
	const span: Span = {
		traceId: parent?.traceId ?? hex(32),
		spanId: hex(16),
		parentId: parent?.spanId ?? null,
		service,
		name,
		start: now(),
		end: 0,
		attributes: { ...attributes },
		status: 'ok'
	};
	const active: Active = {
		traceId: span.traceId,
		spanId: span.spanId,
		sampled: parent?.sampled ?? true,
		service,
		span
	};
	try {
		return await storage.run(active, () => work(span));
	} catch (error) {
		span.status = 'error';
		throw error;
	} finally {
		span.end = now();
		if (active.sampled) spans.push(span);
	}
}

export async function childSpan<T>(
	name: string,
	attributes: Record<string, string | number>,
	work: (span: Span) => Promise<T>
): Promise<T> {
	const parent = current();
	return withSpan(parent?.service ?? 'unknown', name, parent ?? null, attributes, work);
}

export function log(
	level: LogLine['level'],
	msg: string,
	fields: Record<string, string | number> = {}
): void {
	const active = current();
	logs.push({
		ms: Math.round(now()),
		level,
		service: active?.service ?? 'unknown',
		trace_id: active?.traceId ?? null,
		span_id: active?.spanId ?? null,
		msg,
		...fields
	});
}

export async function call(
	service: string,
	url: string,
	propagate = true
): Promise<{ status: number; body: unknown }> {
	return childSpan(`HTTP GET → ${service}`, { 'peer.service': service }, async (span) => {
		const active = current();
		const headers: Record<string, string> = {};
		if (propagate && active) headers.traceparent = formatTraceparent(active);
		const response = await fetch(url, { headers });
		const body: unknown = await response.json();
		span.attributes['http.status_code'] = response.status;
		if (response.status >= 500) span.status = 'error';
		return { status: response.status, body };
	});
}
