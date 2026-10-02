import type { Ctx } from './deps';

export const JOURNEYS = [
	'login',
	'board',
	'create-task',
	'comment',
	'search',
	'upload',
	'share-link'
] as const;

export type Journey = (typeof JOURNEYS)[number];

export type Handlers = Record<Journey, (ctx: Ctx) => void>;

export const asWritten: Handlers = {
	login(ctx) {
		ctx.call('redis-limiter');
		ctx.call('flags');
		ctx.call('pg-primary');
		ctx.commit();
	},
	board(ctx) {
		ctx.attempt(() => ctx.call('redis-limiter'));
		ctx.call('flags');
		if (!ctx.attempt(() => ctx.call('redis-cache'))) ctx.call('pg-replica');
		ctx.parallel(
			(c) => c.call('pg-replica'),
			(c) => c.call('billing'),
			(c) => c.call('pg-replica')
		);
	},
	'create-task'(ctx) {
		ctx.attempt(() => ctx.call('redis-limiter'));
		ctx.call('flags');
		ctx.soft('quota pending', () => ctx.call('billing', 300));
		ctx.call('pg-primary');
		ctx.commit();
		ctx.call('redis-cache');
	},
	comment(ctx) {
		ctx.attempt(() => ctx.call('redis-limiter'));
		ctx.call('flags');
		ctx.call('pg-primary');
		ctx.commit();
		ctx.call('redis-queue');
	},
	search(ctx) {
		ctx.attempt(() => ctx.call('redis-limiter'));
		ctx.call('flags');
		ctx.call('pg-replica');
	},
	upload(ctx) {
		ctx.call('flags');
		ctx.call('object-storage');
		ctx.call('object-storage');
		ctx.call('pg-primary');
		ctx.commit();
	},
	'share-link'(ctx) {
		ctx.call('flags');
		if (!ctx.attempt(() => ctx.call('redis-cache'))) ctx.call('pg-replica');
	}
};

function readWithFallback(ctx: Ctx): void {
	if (ctx.attempt(() => ctx.call('pg-replica', 500))) return;
	ctx.degraded.add('replica → primary');
	ctx.call('pg-primary', 500);
}

export const designed: Handlers = {
	login(ctx) {
		ctx.call('redis-limiter', 50);
		ctx.call('pg-primary', 800);
		ctx.commit();
	},
	board(ctx) {
		ctx.attempt(() => ctx.call('redis-limiter', 50));
		if (!ctx.attempt(() => ctx.call('redis-cache', 50))) readWithFallback(ctx);
		ctx.parallel(
			(c) => c.soft('comment counts', () => c.call('pg-replica', 300)),
			(c) => c.soft('plan badge', () => c.call('billing', 150)),
			(c) => c.soft('activity panel', () => c.call('pg-replica', 300))
		);
	},
	'create-task'(ctx) {
		ctx.attempt(() => ctx.call('redis-limiter', 50));
		ctx.soft('quota pending', () => ctx.call('billing', 300));
		ctx.call('pg-primary', 800);
		ctx.commit();
		ctx.soft('cache stale ≤ 5 min', () => ctx.call('redis-cache', 50));
	},
	comment(ctx) {
		ctx.attempt(() => ctx.call('redis-limiter', 50));
		ctx.call('pg-primary', 800);
		ctx.commit();
	},
	search(ctx) {
		ctx.attempt(() => ctx.call('redis-limiter', 50));
		ctx.call('pg-replica', 1_000);
	},
	upload(ctx) {
		ctx.call('object-storage', 2_000);
		ctx.call('object-storage', 500);
		ctx.call('pg-primary', 800);
		ctx.commit();
	},
	'share-link'(ctx) {
		if (!ctx.attempt(() => ctx.call('redis-cache', 50))) readWithFallback(ctx);
	}
};
