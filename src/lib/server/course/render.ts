import MarkdownIt from 'markdown-it';
import Prism from 'prismjs';
import sanitizeHtml from 'sanitize-html';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-markdown';
import { localizedHref, type Locale } from '../../docs/i18n';
import { lessonBody } from './catalog';
export type Heading = { id: string; text: string; level: number };
export function renderLesson(raw: string, locale: Locale) {
	const headings: Heading[] = [];
	const md = new MarkdownIt({
		html: true,
		linkify: true,
		typographer: false,
		highlight(code, language) {
			const grammar = Prism.languages[language];
			return grammar ? Prism.highlight(code, grammar, language) : '';
		}
	});
	const tokens = md.parse(lessonBody(raw), {});
	const counts = new Map<string, number>();
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === 'heading_open') {
			const inline = tokens[i + 1];
			const text =
				inline?.children
					?.filter((t) => t.type === 'text' || t.type === 'code_inline')
					.map((t) => t.content)
					.join('') ||
				inline?.content ||
				'Section';
			const base =
				text
					.toLowerCase()
					.replace(/[^\p{L}\p{N}\p{M}\s-]/gu, '')
					.trim()
					.replace(/\s+/g, '-') || 'section';
			const count = (counts.get(base) ?? 0) + 1;
			counts.set(base, count);
			const id = count === 1 ? base : `${base}-${count}`;
			token.attrSet('id', id);
			if (token.tag === 'h2' || token.tag === 'h3')
				headings.push({ id, text, level: Number(token.tag.slice(1)) });
		}
		for (const child of token.children ?? []) {
			if (child.type !== 'link_open') continue;
			const href = String(child.attrGet('href') ?? '');
			if (href.startsWith('http://') || href.startsWith('https://'))
				child.attrSet('rel', 'noopener noreferrer');
			// Keep source-relative Markdown links inside the numbered course routes.
			const lesson = href.match(/(?:^|\/)lesson-(\d+\.\d+)[^/]*\.md(#.*)?$/);
			const challenge = href.match(
				/(?:^|\/)module-(\d+)-exit-challenge(?:\.(?:en|bn))?\.md(#.*)?$/
			);
			if (lesson)
				child.attrSet('href', localizedHref(`/lesson-${lesson[1]}${lesson[2] ?? ''}`, locale));
			else if (challenge)
				child.attrSet(
					'href',
					localizedHref(`/lesson-${Number(challenge[1])}-challenge${challenge[2] ?? ''}`, locale)
				);
		}
	}
	const firstSection = tokens.findIndex(
		(token) => token.type === 'heading_open' && token.tag === 'h2' && token.level === 0
	);
	const rendered =
		firstSection > 0
			? `<div class="lesson-intro">${md.renderer.render(tokens.slice(0, firstSection), md.options, {})}</div>${md.renderer.render(tokens.slice(firstSection), md.options, {})}`
			: md.renderer.render(tokens, md.options, {});
	const html = sanitizeHtml(rendered, {
		allowedTags: [...sanitizeHtml.defaults.allowedTags, 'details', 'summary', 'img'],
		allowedAttributes: {
			...sanitizeHtml.defaults.allowedAttributes,
			'*': ['id', 'class'],
			a: [...(sanitizeHtml.defaults.allowedAttributes.a ?? []), 'rel'],
			details: ['open'],
			img: ['src', 'alt', 'width', 'height', 'loading']
		},
		allowedSchemes: ['http', 'https', 'mailto']
	});
	return { html, headings };
}
