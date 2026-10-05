import type { KitConfig } from '@sveltejs/kit';

type CspDirectives = NonNullable<NonNullable<KitConfig['csp']>['directives']>;

export const announcerStyleHash = 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo=' as const;

export const cspDirectives = {
	'default-src': ['self'],
	'script-src': ['self'],
	'style-src': ['self'],
	'style-src-attr': ['unsafe-hashes', announcerStyleHash],
	'img-src': ['self', 'data:'],
	'font-src': ['self'],
	'connect-src': ['self'],
	'object-src': ['none'],
	'base-uri': ['self'],
	'form-action': ['self'],
	'frame-ancestors': ['none']
} satisfies CspDirectives;
