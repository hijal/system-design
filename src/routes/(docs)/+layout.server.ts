import { catalogs } from '$lib/server/course';
import type { LayoutServerLoad } from './$types';
export const load: LayoutServerLoad = ({ locals, url }) => {
	url.searchParams.get('lang');
	return { modules: catalogs[locals.courseLocale].modules, locale: locals.courseLocale };
};
