import { catalogs } from '$lib/server/course';
import { buildSitemap } from '$lib/server/course/sitemap';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) =>
	new Response(buildSitemap(url.origin, catalogs), {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			'cache-control': 'public, max-age=3600'
		}
	});
