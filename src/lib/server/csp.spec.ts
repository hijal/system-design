import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { announcerStyleHash, cspDirectives } from './csp';

describe('content security policy', () => {
	it("allows exactly the inline style of SvelteKit's route announcer", () => {
		const root = readFileSync('.svelte-kit/generated/root.svelte', 'utf8');
		const style = root.match(/id="svelte-announcer"[^>]*style="([^"]*)"/)?.[1];
		expect(style).toBeDefined();
		const hash = `sha256-${createHash('sha256')
			.update(style ?? '')
			.digest('base64')}`;
		expect(announcerStyleHash).toBe(hash);
	});
	it('never allows arbitrary inline styles or scripts', () => {
		for (const directive of ['script-src', 'style-src', 'style-src-attr'] as const)
			expect(cspDirectives[directive]).not.toContain('unsafe-inline');
	});
});
