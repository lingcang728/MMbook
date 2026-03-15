import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { createHighlighter, type Highlighter } from 'shiki';

let highlighter: Highlighter | null = null;

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
				'cpp'
			]
		});
	}
	return highlighter;
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
		.use(rehypeSourcePos)
		.use(rehypeStringify, { allowDangerousHtml: true })
		.process(source);

	let html = String(result);

	// Enhance code blocks with Shiki
	html = html.replace(
		/<pre[^>]*><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
		(_, lang, code) => {
			const decoded = code
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&amp;/g, '&')
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'");
			try {
				return hl.codeToHtml(decoded, {
					lang,
					themes: { light: 'github-light', dark: 'github-dark' }
				});
			} catch {
				return `<pre><code class="language-${lang}">${code}</code></pre>`;
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

export function extractToc(html: string): TocItem[] {
	const items: TocItem[] = [];
	const regex = /<h([1-6])[^>]*id="([^"]*)"[^>]*>(.*?)<\/h[1-6]>/g;
	let match;
	while ((match = regex.exec(html)) !== null) {
		items.push({
			level: parseInt(match[1]),
			text: match[3].replace(/<[^>]*>/g, ''),
			id: match[2]
		});
	}

	// If no IDs in headings, generate them
	if (items.length === 0) {
		const regex2 = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/g;
		while ((match = regex2.exec(html)) !== null) {
			const text = match[2].replace(/<[^>]*>/g, '');
			const id = text
				.toLowerCase()
				.replace(/[^\w\u4e00-\u9fff]+/g, '-')
				.replace(/^-|-$/g, '');
			items.push({ level: parseInt(match[1]), text, id });
		}
	}

	return items;
}

export function addHeadingIds(html: string): string {
	return html.replace(/<h([1-6])([^>]*)>(.*?)<\/h[1-6]>/g, (full, level, attrs, content) => {
		if (attrs.includes('id=')) return full;
		const text = content.replace(/<[^>]*>/g, '');
		const id = text
			.toLowerCase()
			.replace(/[^\w\u4e00-\u9fff]+/g, '-')
			.replace(/^-|-$/g, '');
		return `<h${level}${attrs} id="${id}">${content}</h${level}>`;
	});
}
