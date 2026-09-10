import { describe, expect, it } from 'vitest';
import { createEmptyPage } from './createEmptyPage.js';
import { marksAtCaret, normalizePage, normalizeSpans, sanitizeIndent, sanitizeLineHeight } from './normalize.js';
import { documentOrder } from './tree.js';
import { isNonTextual, isUnknownBlock } from './plaintext.js';
import { KB_FORMAT, type KbPage, type Mark, type TextSpan } from './types.js';

function span(text: string, marks: Mark[] = []): TextSpan {
	return { type: 'text', text, marks };
}

describe('marksAtCaret', () => {
	it('drops link at the trailing edge and keeps it inside', () => {
		const link = { type: 'link' as const, href: 'https://example.com' };
		const spans = [span('ab', [link]), span('cd')];
		expect(marksAtCaret(spans, 1)).toEqual([link]);
		expect(marksAtCaret(spans, 2)).toEqual([]);
		expect(marksAtCaret(spans, 0)).toEqual([link]);
		expect(marksAtCaret(spans, 4)).toEqual([]);
	});
});

describe('sanitizeLineHeight', () => {
	it('accepts unitless multipliers in range and rejects junk', () => {
		expect(sanitizeLineHeight('1.5')).toBe('1.5');
		expect(sanitizeLineHeight('1.50')).toBe('1.5');
		expect(sanitizeLineHeight(' 2 ')).toBe('2');
		expect(sanitizeLineHeight('0.7')).toBeNull();
		expect(sanitizeLineHeight('5')).toBeNull();
		expect(sanitizeLineHeight('1.5px')).toBeNull();
		expect(sanitizeLineHeight('')).toBeNull();
	});
});

describe('sanitizeIndent', () => {
	it('keeps 1–8 and drops 0 / junk', () => {
		expect(sanitizeIndent(1)).toBe(1);
		expect(sanitizeIndent(8)).toBe(8);
		expect(sanitizeIndent(0)).toBeUndefined();
		expect(sanitizeIndent(9)).toBeUndefined();
		expect(sanitizeIndent(1.5)).toBeUndefined();
		expect(sanitizeIndent('2')).toBe(2);
		expect(sanitizeIndent('nope')).toBeUndefined();
	});
});

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

	it('sorts marks bold, italic, underline, color, highlight, code, link and last link href wins', () => {
		const marks: Mark[] = [
			{ type: 'link', href: 'https://a.example' },
			{ type: 'code' },
			{ type: 'highlight', color: 'yellow' },
			{ type: 'color', color: 'red' },
			{ type: 'underline' },
			{ type: 'bold' },
			{ type: 'italic' },
			{ type: 'link', href: 'https://b.example' }
		];
		expect(normalizeSpans([span('x', marks)])[0].marks).toEqual([
			{ type: 'bold' },
			{ type: 'italic' },
			{ type: 'underline' },
			{ type: 'color', color: 'red' },
			{ type: 'highlight', color: 'yellow' },
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

	it('keeps page_break as a known atomic leaf', () => {
		const page = {
			format: KB_FORMAT,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [{ id: 'pb', type: 'page_break', extra: true }]
		} as unknown as KbPage;
		const normalized = normalizePage(page);
		expect(normalized.blocks[0]).toEqual({ id: 'pb', type: 'page_break' });
		expect(isUnknownBlock(normalized.blocks[0])).toBe(false);
		expect(isNonTextual(normalized.blocks[0])).toBe(true);
	});

	it('preserves unknown leaf block types verbatim (lossless across load/save)', () => {
		const page = {
			format: KB_FORMAT,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [{ id: 'x', type: 'embed', text: 'Hidden', flag: true }]
		} as unknown as KbPage;
		const normalized = normalizePage(page);
		expect(normalized.blocks[0]).toEqual({
			id: 'x',
			type: 'embed',
			text: 'Hidden',
			flag: true
		});
		expect(isUnknownBlock(normalized.blocks[0])).toBe(true);
		expect(isNonTextual(normalized.blocks[0])).toBe(true);
	});

	it('preserves unknown container children without traversing them', () => {
		const page = {
			format: KB_FORMAT,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [
				{
					id: 'acc',
					type: 'accordion',
					flag: true,
					children: [{ id: 'n', type: 'paragraph', content: [span('keep')] }]
				}
			]
		} as unknown as KbPage;
		const normalized = normalizePage(page);
		expect(normalized.blocks[0]).toEqual({
			id: 'acc',
			type: 'accordion',
			flag: true,
			children: [{ id: 'n', type: 'paragraph', content: [span('keep')] }]
		});
		// Opaque to traversal: the child is not in document order.
		expect(documentOrder(normalized).map((b) => b.id)).toEqual(['acc']);
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
