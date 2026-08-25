import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizePage } from './normalize.js';
import { parseKb } from './parse.js';
import { toMarkdown } from './toMarkdown.js';
import { KB_FORMAT, type Block, type KbPage, type Mark, type TextSpan } from './types.js';

const srcDir = dirname(fileURLToPath(import.meta.url));
const STAMP = '2026-01-01T00:00:00.000Z';

function span(text: string, marks: Mark[] = []): TextSpan {
	return { type: 'text', text, marks };
}

function page(blocks: Block[]): KbPage {
	return normalizePage({
		format: KB_FORMAT,
		schemaVersion: 1,
		id: 'page-1',
		title: 'Title is not exported',
		createdAt: STAMP,
		updatedAt: STAMP,
		children: [],
		blocks
	});
}

function md(blocks: Block[]): string {
	return toMarkdown(page(blocks));
}

describe('toMarkdown', () => {
	it('separates paragraphs with a blank line', () => {
		expect(
			md([
				{ id: 'p1', type: 'paragraph', content: [span('Hello')] },
				{ id: 'p2', type: 'paragraph', content: [span('World')] }
			])
		).toBe('Hello\n\nWorld\n');
	});

	it('renders heading levels as # / ## / ###', () => {
		expect(
			md([
				{ id: 'h1', type: 'heading', level: 1, content: [span('One')] },
				{ id: 'h2', type: 'heading', level: 2, content: [span('Two')] },
				{ id: 'h3', type: 'heading', level: 3, content: [span('Three')] }
			])
		).toBe('# One\n\n## Two\n\n### Three\n');
	});

	it('renders unordered list_item as "- "', () => {
		expect(
			md([
				{ id: 'a', type: 'list_item', ordered: false, content: [span('alpha')] },
				{ id: 'b', type: 'list_item', ordered: false, content: [span('beta')] }
			])
		).toBe('- alpha\n- beta\n');
	});

	it('increments ordered list_item among adjacent same-ordered items', () => {
		expect(
			md([
				{ id: 'a', type: 'list_item', ordered: true, content: [span('one')] },
				{ id: 'b', type: 'list_item', ordered: true, content: [span('two')] },
				{ id: 'c', type: 'list_item', ordered: true, content: [span('three')] }
			])
		).toBe('1. one\n2. two\n3. three\n');
	});

	it('resets ordered numbering when the run is broken', () => {
		expect(
			md([
				{ id: 'a', type: 'list_item', ordered: true, content: [span('one')] },
				{ id: 'b', type: 'list_item', ordered: true, content: [span('two')] },
				{ id: 'p', type: 'paragraph', content: [span('break')] },
				{ id: 'c', type: 'list_item', ordered: true, content: [span('again')] },
				{ id: 'd', type: 'list_item', ordered: false, content: [span('bullet')] },
				{ id: 'e', type: 'list_item', ordered: true, content: [span('fresh')] }
			])
		).toBe('1. one\n2. two\n\nbreak\n\n1. again\n\n- bullet\n\n1. fresh\n');
	});

	it('fences code with ```language and keeps interior newlines', () => {
		expect(md([{ id: 'c', type: 'code', language: 'ts', text: 'const n = 1;\n' }])).toBe(
			'```ts\nconst n = 1;\n```\n'
		);
		expect(md([{ id: 'c', type: 'code', language: '', text: 'plain' }])).toBe('```\nplain\n```\n');
	});

	it('renders divider as ---', () => {
		expect(md([{ id: 'd', type: 'divider' }])).toBe('---\n');
	});

	it('renders image as ![alt](src)', () => {
		expect(md([{ id: 'i', type: 'image', src: 'assets/diagram.png', alt: 'Diagram' }])).toBe(
			'![Diagram](assets/diagram.png)\n'
		);
	});

	it('wraps marks as **bold** *italic* `code` [text](href)', () => {
		expect(md([{ id: 'p', type: 'paragraph', content: [span('bold', [{ type: 'bold' }])] }])).toBe(
			'**bold**\n'
		);
		expect(md([{ id: 'p', type: 'paragraph', content: [span('em', [{ type: 'italic' }])] }])).toBe(
			'*em*\n'
		);
		expect(md([{ id: 'p', type: 'paragraph', content: [span('id', [{ type: 'code' }])] }])).toBe(
			'`id`\n'
		);
		expect(
			md([
				{
					id: 'p',
					type: 'paragraph',
					content: [span('site', [{ type: 'link', href: 'https://example.com' }])]
				}
			])
		).toBe('[site](https://example.com)\n');
	});

	it('nests marks with code innermost and link outermost', () => {
		expect(
			md([
				{
					id: 'p',
					type: 'paragraph',
					content: [
						span('both', [{ type: 'bold' }, { type: 'italic' }]),
						span(' '),
						span('code', [{ type: 'bold' }, { type: 'italic' }, { type: 'code' }]),
						span(' '),
						span('all', [
							{ type: 'bold' },
							{ type: 'italic' },
							{ type: 'code' },
							{ type: 'link', href: 'https://example.com' }
						])
					]
				}
			])
		).toBe('***both*** ***`code`*** [***`all`***](https://example.com)\n');
		expect(
			md([
				{
					id: 'p',
					type: 'paragraph',
					content: [span('x', [{ type: 'bold' }, { type: 'link', href: 'https://a.example' }])]
				}
			])
		).toBe('[**x**](https://a.example)\n');
	});

	it('matches the all-blocks golden byte-for-byte', () => {
		const json = readFileSync(join(srcDir, 'goldens/all-blocks.json'), 'utf8');
		const golden = readFileSync(join(srcDir, 'goldens/all-blocks.md'), 'utf8');
		expect(golden.endsWith('\n')).toBe(true);
		expect(toMarkdown(parseKb(json))).toBe(golden);
	});

	it('does not export title', () => {
		expect(toMarkdown(page([{ id: 'p', type: 'paragraph', content: [span('body')] }]))).toBe(
			'body\n'
		);
	});

	it('renders a GFM table with aligned columns and skips row/cell chrome', () => {
		expect(
			md([
				{
					id: 't',
					type: 'table',
					children: [
						{
							id: 'r1',
							type: 'table_row',
							children: [
								{
									id: 'c11',
									type: 'table_cell',
									header: true,
									content: [span('A', [{ type: 'bold' }])]
								},
								{ id: 'c12', type: 'table_cell', header: true, content: [span('B')] }
							]
						},
						{
							id: 'r2',
							type: 'table_row',
							children: [
								{ id: 'c21', type: 'table_cell', content: [span('a|b')] },
								{ id: 'c22', type: 'table_cell', content: [span('d')] }
							]
						}
					]
				},
				{ id: 'z', type: 'paragraph', content: [span('after')] }
			])
		).toBe('| **A** | B   |\n| ----- | --- |\n| a\\|b  | d   |\n\nafter\n');
	});

	it('keeps empty GFM cells so the grid stays rectangular', () => {
		expect(
			md([
				{
					id: 't',
					type: 'table',
					children: [
						{
							id: 'r1',
							type: 'table_row',
							children: [
								{ id: 'c11', type: 'table_cell', header: true, content: [span('A')] },
								{ id: 'c12', type: 'table_cell', header: true, content: [span('B')] },
								{ id: 'c13', type: 'table_cell', header: true, content: [] }
							]
						},
						{
							id: 'r2',
							type: 'table_row',
							children: [
								{ id: 'c21', type: 'table_cell', content: [] },
								{ id: 'c22', type: 'table_cell', content: [span('d')] },
								{ id: 'c23', type: 'table_cell', content: [] }
							]
						}
					]
				}
			])
		).toBe('| A   | B   |     |\n| --- | --- | --- |\n|     | d   |     |\n');
	});

	it('quotes callout children including nested lists', () => {
		expect(
			md([
				{
					id: 'c',
					type: 'callout',
					variant: 'info',
					children: [
						{ id: 'n1', type: 'paragraph', content: [span('note')] },
						{ id: 'n2', type: 'paragraph', content: [span('body')] },
						{ id: 'u1', type: 'list_item', ordered: false, content: [span('alpha')] },
						{ id: 'u2', type: 'list_item', ordered: false, content: [span('beta')] },
						{ id: 'o1', type: 'list_item', ordered: true, content: [span('one')] },
						{ id: 'o2', type: 'list_item', ordered: true, content: [span('two')] }
					]
				},
				{ id: 'z', type: 'paragraph', content: [span('after')] }
			])
		).toBe('> note\n>\n> body\n>\n> - alpha\n> - beta\n>\n> 1. one\n> 2. two\n\nafter\n');
	});

	it('exports open toggle children and wraps closed toggle children in details', () => {
		expect(
			md([
				{
					id: 't',
					type: 'toggle',
					open: true,
					children: [{ id: 's', type: 'paragraph', content: [span('shown')] }]
				}
			])
		).toBe('shown\n');
		expect(
			md([
				{
					id: 't',
					type: 'toggle',
					open: false,
					children: [{ id: 'h', type: 'paragraph', content: [span('hidden')] }]
				}
			])
		).toBe('<details>\n\nhidden\n</details>\n');
	});
});
