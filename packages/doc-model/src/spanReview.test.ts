import { describe, expect, it } from 'vitest';
import { apply, applyMany } from './apply.js';
import { invert } from './invert.js';
import { mapPointThroughOp } from './mapPoint.js';
import { marksAtCaret, missingSpanIds, normalizePage, normalizeSpans, splitSpans } from './normalize.js';
import { findBlock } from './tree.js';
import { KB_FORMAT, type Block, type KbPage, type Mark, type Op, type TextSpan } from './types.js';

const STAMP = '2026-01-01T00:00:00.000Z';

function span(text: string, marks: Mark[] = [], id?: string): TextSpan {
	const next: TextSpan = { type: 'text', text, marks };
	if (id) next.id = id;
	return next;
}

function page(blocks: Block[]): KbPage {
	return normalizePage({
		format: KB_FORMAT,
		id: 'page-1',
		title: 'Title',
		createdAt: STAMP,
		updatedAt: STAMP,
		children: [],
		blocks
	});
}

function para(id: string, text: string, marks: Mark[] = []): Block {
	return { id, type: 'paragraph', content: [span(text, marks)] };
}

function contentOf(doc: KbPage, id: string): TextSpan[] {
	const block = findBlock(doc, id);
	if (!block || !('content' in block)) throw new Error(`no text block ${id}`);
	return (block as { content: TextSpan[] }).content;
}

describe('span ids', () => {
	it('stamp sets missing ids, does not overwrite existing different ids, second apply is a no-op', () => {
		const src = page([
			{
				id: 'p',
				type: 'paragraph',
				content: [span('ab'), span('cd', [{ type: 'bold' }], 'keep')]
			},
			{ id: 'd', type: 'divider' }
		]);
		const op: Op = {
			kind: 'stamp-span-ids',
			spans: [
				{ blockId: 'p', index: 0, id: 'new' },
				{ blockId: 'p', index: 1, id: 'other' },
				{ blockId: 'missing', index: 0, id: 'nope' },
				{ blockId: 'd', index: 0, id: 'nope' }
			]
		};
		const once = apply(src, op);
		expect(contentOf(once, 'p')).toEqual([
			span('ab', [], 'new'),
			span('cd', [{ type: 'bold' }], 'keep')
		]);
		expect(apply(once, op)).toEqual(once);
		expect(
			apply(once, { kind: 'stamp-span-ids', spans: [{ blockId: 'p', index: 0, id: 'clash' }] })
		).toEqual(once);
		expect(applyMany(once, invert(src, op))).toEqual(src);
	});

	it('missingSpanIds walks nested text blocks and does not mint ids', () => {
		const src = page([
			para('p', 'top'),
			{
				id: 'c',
				type: 'callout',
				variant: 'info',
				children: [{ id: 'inner', type: 'paragraph', content: [span('b', [], 'has')] }]
			},
			{
				id: 'tg',
				type: 'toggle',
				open: false,
				children: [{ id: 'hid', type: 'list_item', ordered: false, content: [span('c')] }]
			},
			{
				id: 'tb',
				type: 'table',
				children: [
					{
						id: 'row',
						type: 'table_row',
						children: [{ id: 'cell', type: 'table_cell', content: [span('d')] }]
					}
				]
			}
		]);
		const before = JSON.stringify(src);
		expect(missingSpanIds(src)).toEqual([
			{ blockId: 'p', index: 0 },
			{ blockId: 'hid', index: 0 },
			{ blockId: 'cell', index: 0 }
		]);
		expect(JSON.stringify(src)).toBe(before);
	});

	it('splitSpans copies id onto both halves and does not invent one', () => {
		const [left, right] = splitSpans([span('abcd', [], 's')], 2);
		expect(left).toEqual([span('ab', [], 's')]);
		expect(right).toEqual([span('cd', [], 's')]);
		const [plainL, plainR] = splitSpans([span('ab')], 1);
		expect(plainL[0].id).toBeUndefined();
		expect(plainR[0].id).toBeUndefined();
	});

	it('normalizeSpans merge of different ids keeps the left id', () => {
		const bold: Mark[] = [{ type: 'bold' }];
		expect(normalizeSpans([span('a', bold, 'L'), span('b', bold, 'R')])).toEqual([span('ab', bold, 'L')]);
		expect(normalizeSpans([span('a', bold), span('b', bold, 'R')])).toEqual([span('ab', bold, 'R')]);
		expect(
			normalizeSpans([
				span('a', [{ type: 'review', id: 'r1', style: 'marker', color: 'yellow' }]),
				span('b', [{ type: 'review', id: 'r2', style: 'marker', color: 'red' }])
			])
		).toHaveLength(2);
	});

	it('coerce round-trip keeps span id', () => {
		const raw = {
			format: KB_FORMAT,
			id: 'page-1',
			title: 'Title',
			createdAt: STAMP,
			updatedAt: STAMP,
			children: [],
			blocks: [{ id: 'p', type: 'paragraph', content: [span('hi', [], 's1')] }]
		} as unknown as KbPage;
		const once = normalizePage(raw);
		expect(contentOf(once, 'p')[0].id).toBe('s1');
		expect(normalizePage(once)).toEqual(once);
	});

	it('insert-text with spanId lands on the new span when marks differ, and the left id wins on merge', () => {
		const src = page([{ id: 'p', type: 'paragraph', content: [span('ab', [{ type: 'bold' }], 'left')] }]);
		const landed = apply(src, {
			kind: 'insert-text',
			at: { blockId: 'p', offset: 2 },
			text: 'X',
			marks: [],
			spanId: 'new'
		});
		expect(contentOf(landed, 'p')).toEqual([
			span('ab', [{ type: 'bold' }], 'left'),
			span('X', [], 'new')
		]);
		const merged = apply(src, {
			kind: 'insert-text',
			at: { blockId: 'p', offset: 2 },
			text: 'X',
			spanId: 'new'
		});
		expect(contentOf(merged, 'p')).toEqual([span('abX', [{ type: 'bold' }], 'left')]);
	});

	it('mapPoint of stamp-span-ids is identity', () => {
		const src = page([para('p', 'ab')]);
		const point = { blockId: 'p', offset: 1, assoc: 1 as const };
		const op: Op = { kind: 'stamp-span-ids', spans: [{ blockId: 'p', index: 0, id: 's' }] };
		expect(mapPointThroughOp(src, point, op)).toEqual(point);
	});
});

describe('review mark', () => {
	const marker: Mark = { type: 'review', id: 'r1', style: 'marker', color: 'yellow', note: 'n' };
	const other: Mark = { type: 'review', id: 'r2', style: 'underline', color: 'red' };

	function markedPage(): KbPage {
		return page([para('a', 'hello', [marker]), para('b', 'world', [marker]), para('c', 'other', [other])]);
	}

	it('orders review after highlight and before code', () => {
		expect(
			normalizeSpans([
				span('x', [
					{ type: 'code' },
					{ type: 'review', id: 'r', style: 'marker', color: 'yellow' },
					{ type: 'highlight', color: 'amber' }
				])
			])[0].marks
		).toEqual([
			{ type: 'highlight', color: 'amber' },
			{ type: 'review', id: 'r', style: 'marker', color: 'yellow' },
			{ type: 'code' }
		]);
	});

	it('format-range of a review mark across two blocks writes the same id on both', () => {
		const src = page([para('a', 'hello'), para('b', 'world'), para('c', 'other', [other])]);
		const next = apply(src, {
			kind: 'format-range',
			range: { anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'b', offset: 5 } },
			mark: marker,
			on: true
		});
		expect(contentOf(next, 'a')[0].marks).toEqual([marker]);
		expect(contentOf(next, 'b')[0].marks).toEqual([marker]);
		expect(contentOf(next, 'c')[0].marks).toEqual([other]);
	});

	it('marksAtCaret inside keeps a review mark and drops it at the trailing edge', () => {
		const spans = [span('ab', [marker]), span('cd')];
		expect(marksAtCaret(spans, 1)).toEqual([marker]);
		expect(marksAtCaret(spans, 0)).toEqual([marker]);
		expect(marksAtCaret(spans, 2)).toEqual([]);
		expect(marksAtCaret(spans, 4)).toEqual([]);
		expect(marksAtCaret([span('ab', [marker]), span('cd', [marker])], 2)).toEqual([marker]);
		const bold: Mark = { type: 'bold' };
		expect(marksAtCaret([span('ab', [bold, marker]), span('cd', [bold])], 2)).toEqual([bold]);
	});

	it('set-review recolors every span with that id and one invert restores both', () => {
		const src = markedPage();
		const op: Op = { kind: 'set-review', id: 'r1', color: 'blue' };
		const next = apply(src, op);
		const blue: Mark = { type: 'review', id: 'r1', style: 'marker', color: 'blue', note: 'n' };
		expect(contentOf(next, 'a')[0].marks).toEqual([blue]);
		expect(contentOf(next, 'b')[0].marks).toEqual([blue]);
		expect(contentOf(next, 'c')[0].marks).toEqual([other]);
		expect(applyMany(next, invert(src, op))).toEqual(src);
		expect(apply(src, { kind: 'set-review', id: 'missing', color: 'green' })).toEqual(src);
	});

	it('set-review remove clears it and note null clears the note', () => {
		const src = markedPage();
		const removed = apply(src, { kind: 'set-review', id: 'r1', remove: true });
		expect(contentOf(removed, 'a')[0].marks).toEqual([]);
		expect(contentOf(removed, 'b')[0].marks).toEqual([]);
		expect(contentOf(removed, 'c')[0].marks).toEqual([other]);
		expect(applyMany(removed, invert(src, { kind: 'set-review', id: 'r1', remove: true }))).toEqual(src);
		const cleared = apply(src, { kind: 'set-review', id: 'r1', note: null });
		expect(contentOf(cleared, 'a')[0].marks).toEqual([
			{ type: 'review', id: 'r1', style: 'marker', color: 'yellow' }
		]);
		expect(contentOf(cleared, 'b')[0].marks).toEqual([
			{ type: 'review', id: 'r1', style: 'marker', color: 'yellow' }
		]);
	});

	it('coerce drops a review mark with an empty id', () => {
		const dropped = normalizePage({
			format: KB_FORMAT,
			id: 'page-1',
			title: 'Title',
			createdAt: STAMP,
			updatedAt: STAMP,
			children: [],
			blocks: [
				{
					id: 'empty',
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'hi',
							marks: [{ type: 'review', id: '', style: 'marker', color: 'red' }]
						}
					]
				},
				{
					id: 'bad',
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'hi',
							marks: [
								{ type: 'review', id: 'r', style: 'scribble', color: 'red' },
								{ type: 'review', id: 'r', style: 'marker', color: '#ff0000' }
							]
						}
					]
				},
				{
					id: 'kept',
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'hi',
							marks: [
								{ type: 'review', id: 'r', style: 'underline', color: 'blue', note: '   ' },
								{ type: 'bold' }
							]
						}
					]
				},
				{
					id: 'note',
					type: 'paragraph',
					content: [
						{
							type: 'text',
							text: 'hi',
							marks: [{ type: 'review', id: 'kept', style: 'marker', color: 'green', note: '  hi  ' }]
						}
					]
				}
			]
		} as unknown as KbPage);
		expect(contentOf(dropped, 'empty')[0].marks).toEqual([]);
		expect(contentOf(dropped, 'bad')[0].marks).toEqual([]);
		expect(contentOf(dropped, 'kept')[0].marks).toEqual([
			{ type: 'bold' },
			{ type: 'review', id: 'r', style: 'underline', color: 'blue' }
		]);
		expect(contentOf(dropped, 'note')[0].marks).toEqual([
			{ type: 'review', id: 'kept', style: 'marker', color: 'green', note: 'hi' }
		]);
	});

	it('mapPoint of set-review is identity', () => {
		const src = markedPage();
		const point = { blockId: 'a', offset: 1, assoc: 1 as const };
		expect(mapPointThroughOp(src, point, { kind: 'set-review', id: 'r1', color: 'blue' })).toEqual(point);
	});
});
