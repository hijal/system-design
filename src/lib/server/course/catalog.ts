import { englishTitles, localizedHref, type Locale } from '../../docs/i18n';
export type Lesson = {
	id: string;
	title: string;
	moduleId: number;
	href: string;
	available: boolean;
	otherAvailable: boolean;
	minutes: number;
	kind: 'lesson' | 'challenge';
};
export type CourseModule = { id: number; title: string; lessons: Lesson[] };
export function cleanTitle(value: string): string {
	return value
		.replace(/\*\*|`/g, '')
		.replace(/\s*[*_]\(.*?\)[*_]/g, '')
		.trim();
}
export function lessonBody(raw: string): string {
	return raw
		.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
		.replace(/^# .*(?:\r?\n|$)/, '')
		.replace(/^\s*\*\*Module \d+[^\n]*\*\*\s*\n/, '')
		.replace(/^\s*---\s*\n/, '')
		.trim();
}
export function createCatalog(
	base: string,
	sources: Record<string, string>,
	locale: Locale = 'bn'
) {
	const contents = new Map<string, string>();
	for (const [path, raw] of Object.entries(sources)) {
		const file = path.split('/').pop() ?? '';
		const lesson = file.match(/^lesson-(\d+\.\d+)(?:-|\.(?:en\.|bn\.)?md$)/);
		const challenge = file.match(/^module-(\d+)-exit-challenge(?:\.(en|bn))?\.md$/);
		const id = lesson?.[1] ?? (challenge ? `${Number(challenge[1])}-challenge` : undefined);
		if (!id) continue;
		const language: Locale = /\.en\.md$/.test(file) ? 'en' : 'bn';
		const key = `${id}:${language}`;
		if (contents.has(key)) throw new Error(`Duplicate course ID ${key}: ${path}`);
		contents.set(key, raw);
	}
	const modules: CourseModule[] = [];
	let current: CourseModule | undefined;
	const curriculum = base.split('## ৯. Curriculum')[1]?.split('## ১০.')[0] ?? '';
	function entry(id: string, title: string, kind: Lesson['kind'], moduleId: number): Lesson {
		const raw = contents.get(`${id}:${locale}`) ?? '';
		const body = lessonBody(raw);
		const translatedHeading = raw.match(/^#\s+(?:Lesson\s+\d+\.\d+\s*[—–:-]\s*)?(.+)$/m)?.[1];
		return {
			id,
			title:
				locale === 'en'
					? kind === 'challenge'
						? `Module ${moduleId} Exit Challenge`
						: (englishTitles[id] ?? cleanTitle(translatedHeading ?? title))
					: cleanTitle(title),
			moduleId,
			href: localizedHref(`/lesson-${id}`, locale),
			kind,
			available: body.length > 0,
			otherAvailable:
				lessonBody(contents.get(`${id}:${locale === 'bn' ? 'en' : 'bn'}`) ?? '').length > 0,
			minutes: Math.max(1, Math.ceil(body.split(/\s+/).length / 180))
		};
	}
	for (const line of curriculum.split('\n')) {
		const module = line.match(/^### Module (\d+): (.+)$/);
		if (module) {
			current = { id: Number(module[1]), title: module[2], lessons: [] };
			modules.push(current);
			continue;
		}
		if (!current) continue;
		const lesson = line.match(/^- (\d+\.\d+) (.+)$/);
		if (lesson) current.lessons.push(entry(lesson[1], lesson[2], 'lesson', current.id));
		else if (/^- \*\*Module Exit Challenge\*\*/.test(line))
			current.lessons.push(
				entry(
					`${current.id}-challenge`,
					`Module ${current.id} Exit Challenge`,
					'challenge',
					current.id
				)
			);
	}
	// A renamed curriculum heading would otherwise silently produce an empty course.
	if (modules.length === 0)
		throw new Error('No modules found: expected "## ৯. Curriculum" … "## ১০." in course/main.md');
	return { modules, contents, lessons: modules.flatMap((module) => module.lessons) };
}
