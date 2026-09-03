import { describe, expect, it } from 'vitest';
import { createEmptyPage } from './createEmptyPage.js';
import { normalizePage, normalizeSpans } from './normalize.js';
import { KB_FORMAT, type KbPage, type Mark, type TextSpan } from './types.js';

function span(text: string, marks: Mark[] = []): TextSpan {
	return { type: 'text', text, marks };
}

describe('normalizeSpans', () => {
	it('drops empty spans except a single empty span', () => {
		expect(normalizeSpans([])).toEqual([span('')]);
		expect(normalizeSpans([span(''), span('')])).toEqual([span('')]);
		expect(normalizeSpans([span(''), span('ab')])).toEqual([span('ab')]);
	});

	it('merges adjacent spans with equal marks', () => {
		expect(normalizeSpans([span('a', [{ type: 'bold' }]), span('b', [{ type: 'bold' }])])).toEqual([
			span('ab', [{ type: 'bold' }])
		]);
		expect(
			normalizeSpans([span('a', [{ type: 'bold' }]), span('b', [{ type: 'italic' }])])
		).toHaveLength(2);
	});

	it('sorts marks bold, italic, code, link and last link href wins', () => {
		const marks: Mark[] = [
			{ type: 'link', href: 'https://a.example' },
			{ type: 'code' },
			{ type: 'bold' },
			{ type: 'italic' },
			{ type: 'link', href: 'https://b.example' }
		];
		expect(normalizeSpans([span('x', marks)])[0].marks).toEqual([
			{ type: 'bold' },
			{ type: 'italic' },
			{ type: 'code' },
			{ type: 'link', href: 'https://b.example' }
		]);
	});

	it('keeps hard-break newlines in text spans', () => {
		expect(normalizeSpans([span('a\nb')])).toEqual([span('a\nb')]);
	});
});

describe('normalizePage', () => {
	it('keeps blocks.length >= 1 by inserting an empty paragraph', () => {
		const page = createEmptyPage({ id: 'p', title: 't' });
		const emptied = normalizePage({ ...page, blocks: [] });
		expect(emptied.blocks).toHaveLength(1);
		expect(emptied.blocks[0].type).toBe('paragraph');
		expect(emptied.blocks[0].id).not.toBe('');
		if (emptied.blocks[0].type === 'paragraph') {
			expect(emptied.blocks[0].content).toEqual([span('')]);
		}
	});

	it('converts unknown leaf block types to a plaintext paragraph', () => {
		const page = {
			format: KB_FORMAT,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [{ id: 'x', type: 'embed', text: 'Hidden' }]
		} as unknown as KbPage;
		const normalized = normalizePage(page);
		expect(normalized.blocks[0]).toEqual({
			id: 'x',
			type: 'paragraph',
			content: [span('Hidden')]
		});
	});

	it('preserves callout children through orderedBlock', () => {
		const page = {
			format: KB_FORMAT,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [
				{
					id: 'c',
					type: 'callout',
					variant: 'info',
					children: [{ id: 'n', type: 'paragraph', content: [span('in')] }]
				}
			]
		} as unknown as KbPage;
		const normalized = normalizePage(page);
		expect(normalized.blocks[0]).toEqual({
			id: 'c',
			type: 'callout',
			variant: 'info',
			children: [
				{
					id: 'n',
					type: 'paragraph',
					content: [span('in')]
				}
			]
		});
	});

	it('carries no schemaVersion field (machinery stripped)', () => {
		const page = createEmptyPage({ id: 'p', title: 't' });
		expect(page).not.toHaveProperty('schemaVersion');
		expect(normalizePage(page)).not.toHaveProperty('schemaVersion');
	});

	it('flattens nested callouts to depth 1', () => {
		const page = {
			format: KB_FORMAT,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [
				{
					id: 'c',
					type: 'callout',
					variant: 'note',
					children: [
						{
							id: 'inner',
							type: 'callout',
							variant: 'info',
							children: [{ id: 'n', type: 'paragraph', content: [span('in')] }]
						}
					]
				}
			]
		} as unknown as KbPage;
		const normalized = normalizePage(page);
		expect(normalized.blocks[0]).toEqual({
			id: 'c',
			type: 'callout',
			variant: 'note',
			children: [{ id: 'n', type: 'paragraph', content: [span('in')] }]
		});
	});

	it('does not regenerate existing block ids', () => {
		const page = createEmptyPage({ id: 'p', title: 't' });
		const id = page.blocks[0].id;
		expect(normalizePage(page).blocks[0].id).toBe(id);
		expect(normalizePage(normalizePage(page)).blocks[0].id).toBe(id);
	});

	it('pads irregular tables rectangularly without dropping text or existing ids', () => {
		const page = {
			format: KB_FORMAT,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [
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
									content: [{ type: 'text', text: 'keep', marks: [] }]
								},
								{
									id: 'c12',
									type: 'table_cell',
									header: true,
									content: [{ type: 'text', text: 'head', marks: [] }]
								}
							]
						},
						{
							id: 'r2',
							type: 'table_row',
							children: [
								{
									id: 'c21',
									type: 'table_cell',
									content: [{ type: 'text', text: 'short', marks: [] }]
								}
							]
						}
					]
				}
			]
		} as unknown as KbPage;
		const normalized = normalizePage(page);
		expect(normalized.blocks[0].type).toBe('table');
		const table = normalized.blocks[0] as Extract<KbPage['blocks'][number], { type: 'table' }>;
		expect(table.children).toHaveLength(2);
		expect(table.children[0].children.map((c) => c.id)).toEqual(['c11', 'c12']);
		expect(table.children[1].children).toHaveLength(2);
		expect(table.children[1].children[0].id).toBe('c21');
		expect(table.children[1].children[0].content[0].text).toBe('short');
		expect(table.children[1].children[1].type).toBe('table_cell');
		expect(table.children[1].children[1].id).not.toBe('');
		expect(table.children[0].children[1].header).toBe(true);
		expect(table.children[0].children[0].content[0].text).toBe('keep');
		expect(normalizePage(normalized).blocks[0]).toEqual(normalized.blocks[0]);
	});

	it('turns an empty table into a 1x1 empty cell and flattens a table inside a callout', () => {
		const empty = normalizePage({
			format: KB_FORMAT,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [{ id: 't', type: 'table', children: [] }]
		} as unknown as KbPage);
		expect(empty.blocks[0].type).toBe('table');
		const table = empty.blocks[0] as Extract<KbPage['blocks'][number], { type: 'table' }>;
		expect(table.children).toHaveLength(1);
		expect(table.children[0].children).toHaveLength(1);
		expect(table.children[0].children[0].type).toBe('table_cell');

		const nested = normalizePage({
			format: KB_FORMAT,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [
				{
					id: 'c',
					type: 'callout',
					variant: 'info',
					children: [
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
											content: [{ type: 'text', text: 'in', marks: [] }]
										}
									]
								}
							]
						}
					]
				}
			]
		} as unknown as KbPage);
		expect(nested.blocks[0]).toMatchObject({ type: 'callout' });
		const kids = (nested.blocks[0] as { children: { id: string; type: string }[] }).children;
		expect(kids).toEqual([
			{ id: 'c11', type: 'paragraph', content: [{ type: 'text', text: 'in', marks: [] }] }
		]);
	});
});
