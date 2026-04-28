import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { createHighlighter, type Highlighter } from 'shiki';

let highlighter: Highlighter | null = null;
const sanitizeSchema = {
	...defaultSchema,
	attributes: {
		...defaultSchema.attributes,
		code: [
			...((defaultSchema.attributes?.code as any[]) ?? []),
			['className', /^language-[\w+-]+$/]
		]
	}
};

async function getHighlighter(): Promise<Highlighter> {
	if (!highlighter) {
		highlighter = await createHighlighter({
			themes: ['github-light', 'github-dark'],
			langs: [
				'javascript',
				'typescript',
				'python',
				'rust',
				'html',
				'css',
				'json',
				'bash',
				'markdown',
				'yaml',
				'sql',
				'go',
				'java',
				'c',
				'cpp',
				'plaintext'
			]
		});
	}
	return highlighter;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function rehypeSourcePos() {
	const blockTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'ul', 'ol', 'li', 'hr']);
	function walk(node: any) {
		if (node.type === 'element' && node.position && blockTags.has(node.tagName)) {
			if (!node.properties) node.properties = {};
			node.properties.dataSourceStart = node.position.start.line;
			node.properties.dataSourceEnd = node.position.end.line;
		}
		if (node.children) {
			for (const child of node.children) walk(child);
		}
	}
	return (tree: any) => walk(tree);
}

export async function renderMarkdown(source: string): Promise<string> {
	const hl = await getHighlighter();

	const result = await unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeRaw)
		.use(rehypeSanitize, sanitizeSchema)
		.use(rehypeSourcePos)
		.use(rehypeStringify)
		.process(source);

	let html = String(result);

	// Enhance code blocks with Shiki
	html = html.replace(
		/<pre([^>]*)><code class="language-([\w+-]+)">([\s\S]*?)<\/code><\/pre>/g,
		(_, preAttrs, lang, code) => {
			const decoded = code
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&amp;/g, '&')
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'");
			try {
				const loadedLangs = hl.getLoadedLanguages();
				const safeLang = loadedLangs.includes(lang) ? lang : 'plaintext';
				const highlighted = hl.codeToHtml(decoded, {
					lang: safeLang,
					themes: { light: 'github-light', dark: 'github-dark' }
				});
				return highlighted.replace(/^<pre\b/, `<pre${preAttrs}`);
			} catch {
				return `<pre${preAttrs}><code class="language-${lang}">${escapeHtml(decoded)}</code></pre>`;
			}
		}
	);

	return html;
}

export interface TocItem {
	level: number;
	text: string;
	id: string;
}

function decodeHtmlEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, entity) => {
		if (entity[0] === '#') {
			const isHex = entity[1]?.toLowerCase() === 'x';
			const value = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
			if (Number.isFinite(value)) {
				try {
					return String.fromCodePoint(value);
				} catch {
					return full;
				}
			}
			return full;
		}

		const namedEntities: Record<string, string> = {
			amp: '&',
			apos: "'",
			gt: '>',
			lt: '<',
			nbsp: '\u00a0',
			quot: '"'
		};
		return namedEntities[entity] ?? full;
	});
}

function stripHeadingHtml(content: string): string {
	return decodeHtmlEntities(content.replace(/<[^>]*>/g, ''));
}

function generateHeadingId(text: string, seenIds: Map<string, number>): string {
	let id = text.trim().toLowerCase()
		.replace(/[^\w\u4e00-\u9fff]+/g, '-')
		.replace(/^-|-$/g, '');
	// After sanitization, if nothing remains (e.g. "!!!"), fallback to 'unnamed'
	if (!id) {
		id = 'unnamed';
	}
	// IDs starting with digits are invalid in HTML4 and break querySelector
	if (/^\d/.test(id)) {
		id = 'heading-' + id;
	}
	// Ensure uniqueness by appending counter for duplicates
	const count = seenIds.get(id) || 0;
	seenIds.set(id, count + 1);
	if (count > 0) {
		id = `${id}-${count}`;
	}
	return id;
}

export function extractToc(html: string): TocItem[] {
	const items: TocItem[] = [];
	const seenIds = new Map<string, number>();
	const regex = /<h([1-6])[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/h[1-6]>/g;
	let match;
	while ((match = regex.exec(html)) !== null) {
		const text = stripHeadingHtml(match[3]);
		items.push({
			level: parseInt(match[1]),
			text,
			id: match[2]
		});
		seenIds.set(match[2], (seenIds.get(match[2]) || 0) + 1);
	}

	// If no IDs in headings, generate them
	if (items.length === 0) {
		const regex2 = /<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/g;
		while ((match = regex2.exec(html)) !== null) {
			const text = stripHeadingHtml(match[2]);
			const id = generateHeadingId(text, seenIds);
			items.push({ level: parseInt(match[1]), text, id });
		}
	}

	return items;
}

export function addHeadingIds(html: string): string {
	const seenIds = new Map<string, number>();
	return html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h[1-6]>/g, (full, level, attrs, content) => {
		// Require whitespace or start-of-tag before id=, and id= must be followed by a quote
		if (/(^|\s)id\s*=\s*["']/i.test(attrs)) return full;
		const text = stripHeadingHtml(content);
		const id = generateHeadingId(text, seenIds);
		return `<h${level}${attrs} id="${id}">${content}</h${level}>`;
	});
}
