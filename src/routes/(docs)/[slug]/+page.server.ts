import { error, redirect } from '@sveltejs/kit';
import { catalogs } from '$lib/server/course';
import { renderLesson } from '$lib/server/course/render';
import { localizedHref } from '$lib/docs/i18n';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = ({ params, locals, url }) => {
	url.searchParams.get('lang'); // Rerun this load when the selected language changes.
	const locale = locals.courseLocale;
	const aliases: Record<string, string> = { caching: '4.1', 'load-balancing': '3.1' };
	if (aliases[params.slug]) redirect(307, localizedHref(`/lesson-${aliases[params.slug]}`, locale));
	const course = catalogs[locale];
	const id = params.slug.replace(/^lesson-/, '');
	const index = course.lessons.findIndex((l) => l.id === id);
	const lesson = course.lessons[index];
	if (!lesson)
		error(
			404,
			locale === 'bn' ? 'এই lesson-টি curriculum-এ নেই।' : 'This lesson is not in the curriculum.'
		);
	const raw = course.contents.get(`${id}:${locale}`) ?? '';
	const rendered = lesson.available ? renderLesson(raw, locale) : { html: '', headings: [] };
	return {
		lesson,
		raw,
		...rendered,
		module: course.modules.find((m) => m.id === lesson.moduleId)!,
		previous: course.lessons[index - 1] ?? null,
		next: course.lessons[index + 1] ?? null
	};
};
