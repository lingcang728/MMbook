import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown';

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
});
