import { catalogs } from '$lib/server/course';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
	const origin = url.origin;
	const lines: string[] = [
		'# System Design Handbook',
		'',
		'> বাংলা/English bilingual System Design course. Fundamentals থেকে distributed systems পর্যন্ত practical, progressive lessons — TaskFlow নামের একটা running example app-কে ঘিরে।',
		'',
		'Each lesson is available as clean Markdown at `<lesson-url>.md` (e.g. `/lesson-1.1.md`), or `?lang=en` for the English edition where translated.',
		''
	];
	for (const courseModule of catalogs.bn.modules) {
		lines.push(`## Module ${String(courseModule.id).padStart(2, '0')}: ${courseModule.title}`, '');
		for (const lesson of courseModule.lessons) {
			if (!lesson.available) continue;
			const path = lesson.href.split('?')[0];
			lines.push(`- [${lesson.id} — ${lesson.title}](${origin}${path}.md): ${origin}${path}`);
		}
		lines.push('');
	}
	return new Response(lines.join('\n'), {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
};
