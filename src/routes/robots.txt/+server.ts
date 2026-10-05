import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) =>
	new Response(
		['User-agent: *', 'Disallow:', '', `Sitemap: ${url.origin}/sitemap.xml`, ''].join('\n'),
		{
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'public, max-age=3600'
			}
		}
	);
