import { error, redirect } from '@sveltejs/kit';
import { catalogs } from '$lib/server/course';
import { renderLesson } from '$lib/server/course/render';
import { localizedHref } from '$lib/docs/i18n';
import type { PageServerLoad } from './$types';
// Course content is bundled at build time, so a lesson's HTML never changes while the worker lives.
const rendered = new Map<string, ReturnType<typeof renderLesson>>();
function cachedRender(key: string, raw: string, locale: Parameters<typeof renderLesson>[1]) {
	let result = rendered.get(key);
	if (!result) {
		result = renderLesson(raw, locale);
		rendered.set(key, result);
	}
	return result;
}
export const load: PageServerLoad = ({ params, locals, url }) => {
	url.searchParams.get('lang'); // Rerun this load when the selected language changes.
	const locale = locals.courseLocale;
	const aliases: Record<string, string> = { caching: '4.1', 'load-balancing': '3.1' };
	if (aliases[params.slug]) {
		const target = `/lesson-${aliases[params.slug]}`;
		const requested = url.searchParams.get('lang');
		redirect(
			308,
			requested === 'bn' || requested === 'en' ? localizedHref(target, requested) : target
		);
	}
	const course = catalogs[locale];
	const id = params.slug.replace(/^lesson-/, '');
	const index = course.lessons.findIndex((l) => l.id === id);
	const lesson = course.lessons[index];
	if (!lesson)
		error(
			404,
			locale === 'bn' ? 'এই lesson-টি curriculum-এ নেই।' : 'This lesson is not in the curriculum.'
		);
	const key = `${id}:${locale}`;
	const raw = course.contents.get(key) ?? '';
	const page = lesson.available ? cachedRender(key, raw, locale) : { html: '', headings: [] };
	return {
		lesson,
		...page,
		module: course.modules.find((m) => m.id === lesson.moduleId)!,
		previous: course.lessons[index - 1] ?? null,
		next: course.lessons[index + 1] ?? null
	};
};
