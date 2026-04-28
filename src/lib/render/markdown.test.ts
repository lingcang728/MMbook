import { describe, expect, it } from 'vitest';

import { addHeadingIds, extractToc, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
	it('sanitizes unsafe HTML payloads', async () => {
		const source = [
			'# Title',
			'<script>alert("pwn")</script>',
			'<img src="x" onerror="alert(1)" />'
		].join('\n');

		const html = await renderMarkdown(source);

		expect(html.toLowerCase()).not.toContain('<script');
		expect(html.toLowerCase()).not.toContain('onerror=');
	});

	it('keeps source position data attributes for editable blocks', async () => {
		const html = await renderMarkdown('first paragraph\n\nsecond paragraph');

		expect(html).toContain('data-source-start="1"');
		expect(html).toContain('data-source-end="1"');
		expect(html).toContain('data-source-start="3"');
		expect(html).toContain('data-source-end="3"');
	});

	it('still highlights fenced code blocks', async () => {
		const html = await renderMarkdown('```javascript\nconst x = 1;\n```');

		expect(html).toContain('class="shiki');
		expect(html).toContain('const');
	});

	it('preserves source position data on highlighted code blocks', async () => {
		const html = await renderMarkdown('intro\n\n```javascript\nconst x = 1;\n```');

		expect(html).toContain('class="shiki');
		expect(html).toContain('data-source-start="3"');
		expect(html).toContain('data-source-end="5"');
	});

	it('decodes escaped heading text for generated ids and TOC labels', async () => {
		const html = addHeadingIds(await renderMarkdown('# Tom & Jerry'));
		const toc = extractToc(html);

		expect(html).toContain('id="tom-jerry"');
		expect(toc).toEqual([{ level: 1, text: 'Tom & Jerry', id: 'tom-jerry' }]);
	});

	it('generates unique ids for duplicate headings', async () => {
		const html = addHeadingIds(await renderMarkdown('## Duplicate\n\n## Duplicate\n\n## !!!'));
		const toc = extractToc(html);

		expect(toc).toEqual([
			{ level: 2, text: 'Duplicate', id: 'duplicate' },
			{ level: 2, text: 'Duplicate', id: 'duplicate-1' },
			{ level: 2, text: '!!!', id: 'unnamed' }
		]);
	});
});
