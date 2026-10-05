import type { Locale } from '../../docs/i18n';
import type { createCatalog } from './catalog';

type Catalog = ReturnType<typeof createCatalog>;
const locales: Locale[] = ['bn', 'en'];

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function urlEntries(origin: string, path: string, available: Locale[]): string[] {
	const href = (locale: Locale) => escapeXml(`${origin}${path}?lang=${locale}`);
	const alternates = available.map(
		(locale) => `\t\t<xhtml:link rel="alternate" hreflang="${locale}" href="${href(locale)}"/>`
	);
	if (available.includes('bn'))
		alternates.push(
			`\t\t<xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(`${origin}${path}`)}"/>`
		);
	return available.map((locale) =>
		['\t<url>', `\t\t<loc>${href(locale)}</loc>`, ...alternates, '\t</url>'].join('\n')
	);
}

export function buildSitemap(origin: string, catalogs: Record<Locale, Catalog>): string {
	const entries = urlEntries(origin, '/', locales);
	for (const lesson of catalogs.bn.lessons) {
		const available = locales.filter(
			(locale) => catalogs[locale].lessons.find((l) => l.id === lesson.id)?.available
		);
		entries.push(...urlEntries(origin, `/lesson-${lesson.id}`, available));
	}
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
		...entries,
		'</urlset>',
		''
	].join('\n');
}
