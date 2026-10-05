import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	error(
		404,
		locals.courseLocale === 'bn'
			? 'এই ঠিকানায় কোনো পাতা নেই।'
			: 'There is no page at this address.'
	);
};
