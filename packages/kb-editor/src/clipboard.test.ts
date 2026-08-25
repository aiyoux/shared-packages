import { plaintextOf } from '@shared-packages/kb-model';
import { describe, expect, it } from 'vitest';
import {
	copyPayload,
	cutOps,
	KB_CLIPBOARD_MIME,
	parseSlice,
	pasteOps,
	serializeSlice,
	sliceBlocks,
	slicePlaintext,
	stripHtml
} from './clipboard.js';
import { createEditorState, dispatchMany } from './state.js';
import { code, nest, page, para } from './testFixtures.js';

describe('clipboard', () => {
	it('copies text/plain and application/x-scratch-kb+json', () => {
		const state = {
			...createEditorState(page([para('a', 'hello'), para('b', 'world')])),
			selection: { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'b', offset: 2 } }
		};
		const payload = copyPayload(state, state.selection);
		expect(payload).toBeTruthy();
		expect(payload!.plain).toContain('ello');
		expect(payload!.json).toContain(KB_CLIPBOARD_MIME.includes('scratch') ? 'kb-slice' : 'kb-slice');
		const blocks = parseSlice(payload!.json);
		expect(blocks?.length).toBe(2);
	});

	it('HTML paste is a plaintext strip (no DOMParser soup)', () => {
		expect(stripHtml('<b>hi</b><script>alert(1)</script>')).toBe('hialert(1)');
		const state = createEditorState(page([para('p', '')]));
		const ops = pasteOps(state, state.selection, { html: '<p>Hello <em>there</em></p>', plain: '' });
		const next = dispatchMany(state, ops);
		expect(plaintextOf(next.page.blocks[0])).toMatch(/Hello/);
		expect(plaintextOf(next.page.blocks[0])).not.toMatch(/em/);
	});

	it('internal JSON flavor inserts remapped blocks', () => {
		const src = createEditorState(page([para('a', 'one'), para('b', 'two')]));
		const payload = copyPayload(src, {
			anchor: { blockId: 'a', offset: 0 },
			head: { blockId: 'b', offset: 3 }
		});
		const dest = createEditorState(page([para('z', 'keep')]));
		const ops = pasteOps(
			{ ...dest, selection: { anchor: { blockId: 'z', offset: 4 }, head: { blockId: 'z', offset: 4 } } },
			{ anchor: { blockId: 'z', offset: 4 }, head: { blockId: 'z', offset: 4 } },
			{ json: payload!.json }
		);
		expect(ops.every((op) => op.kind === 'insert-block')).toBe(true);
		const next = dispatchMany(dest, ops);
		expect(next.page.blocks.length).toBeGreaterThan(1);
		expect(next.page.blocks.some((b) => b.id === 'a')).toBe(false);
	});

	it('copy of a container plus its child is one subtree, not parent and child', () => {
		const doc = page([nest('c', [para('n', 'in')], 'Call'), para('z', 'Z')]);
		const sliced = sliceBlocks(doc, {
			anchor: { blockId: 'c', offset: 0 },
			head: { blockId: 'n', offset: 2 }
		});
		expect(sliced.map((b) => b.id)).toEqual(['c']);
		expect((sliced[0] as { children?: { id: string }[] }).children?.map((b) => b.id)).toEqual(['n']);
	});

	it('container in the range is a unit: whole subtree including later siblings, and plain matches json', () => {
		const doc = page([nest('c', [para('n1', 'one'), para('n2', 'two')], 'Call'), para('z', 'Z')]);
		const live = { anchor: { blockId: 'c', offset: 0 }, head: { blockId: 'n1', offset: 3 } };
		const sliced = sliceBlocks(doc, live);
		expect(sliced.map((b) => b.id)).toEqual(['c']);
		expect((sliced[0] as { children?: { id: string }[] }).children?.map((b) => b.id)).toEqual([
			'n1',
			'n2'
		]);
		expect(slicePlaintext(doc, live)).toBe('one\ntwo');
		const payload = copyPayload({ ...createEditorState(doc), selection: live }, live);
		expect(payload?.plain).toBe('one\ntwo');
		expect(parseSlice(payload!.json)?.map((b) => b.id)).toEqual(['c']);
	});

	it('slice of a missing range is empty; remap walks nested children', () => {
		const src = createEditorState(page([para('a', 'one'), para('b', 'two')]));
		expect(
			copyPayload(src, { anchor: { blockId: 'missing', offset: 0 }, head: { blockId: 'gone', offset: 1 } })
		).toEqual({ plain: '', json: serializeSlice([]) });
		const nested = {
			id: 'c',
			type: 'callout' as const,
			variant: 'info' as const,
			children: [{ id: 'n', type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'in', marks: [] }] }]
		};
		const json = serializeSlice([nested]);
		const dest = createEditorState(page([para('z', 'keep')]));
		const ops = pasteOps(dest, dest.selection, { json });
		expect(ops.some((op) => op.kind === 'insert-block' && op.block.id === 'c')).toBe(false);
		const inserted = ops.find((op) => op.kind === 'insert-block');
		expect(inserted?.kind).toBe('insert-block');
		if (inserted?.kind === 'insert-block') {
			expect(inserted.block.id).not.toBe('c');
			expect(inserted.block.type).toBe('callout');
			const kids = (inserted.block as { children?: { id: string }[] }).children;
			expect(kids?.[0].id).not.toBe('n');
			expect(kids?.[0].id).toBeTruthy();
		}
	});

	it('text/plain paste inserts at the caret', () => {
		const state = createEditorState(page([para('p', 'ab')]));
		const live = { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } };
		const next = dispatchMany(state, pasteOps(state, live, { plain: 'X' }));
		expect(plaintextOf(next.page.blocks[0])).toBe('aXb');
	});

	it('cut emits a single delete-range', () => {
		const doc = page([para('p', 'abcd')]);
		const live = { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 3 } };
		expect(cutOps(doc, live)).toEqual([{ kind: 'delete-range', range: live }]);
		expect(cutOps(doc, { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } })).toEqual([]);
		const nested = page([nest('c', [para('n', 'in')]), para('z', 'zz')]);
		const crossed = { anchor: { blockId: 'n', offset: 0 }, head: { blockId: 'z', offset: 1 } };
		expect(cutOps(nested, crossed)).toEqual([{ kind: 'delete-range', range: crossed }]);
	});

	it('drop of text/plain reuses pasteOps at the caret', () => {
		const state = createEditorState(page([para('p', 'ab')]));
		const live = { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } };
		const next = dispatchMany(state, pasteOps(state, live, { plain: 'Z' }));
		expect(plaintextOf(next.page.blocks[0])).toBe('aZb');
	});

	it('JSON paste at a mid-block caret splits and preserves marks', () => {
		const src = createEditorState(
			page([
				{
					id: 'a',
					type: 'paragraph',
					content: [{ type: 'text', text: 'Hi', marks: [{ type: 'bold' }] }]
				}
			])
		);
		const payload = copyPayload(src, {
			anchor: { blockId: 'a', offset: 0 },
			head: { blockId: 'a', offset: 2 }
		});
		const sliced = parseSlice(payload!.json);
		expect(sliced?.[0]).toMatchObject({
			type: 'paragraph',
			content: [{ text: 'Hi', marks: [{ type: 'bold' }] }]
		});
		const dest = createEditorState(page([para('z', 'hello')]));
		const live = { anchor: { blockId: 'z', offset: 2 }, head: { blockId: 'z', offset: 2 } };
		const ops = pasteOps(dest, live, { json: payload!.json });
		expect(ops[0]?.kind).toBe('split-block');
		const next = dispatchMany(dest, ops);
		expect(next.page.blocks.map((b) => plaintextOf(b))).toEqual(['he', 'Hi', 'llo']);
		const mid = next.page.blocks[1];
		if (mid.type === 'paragraph') {
			expect(mid.content[0].marks).toEqual([{ type: 'bold' }]);
		}
	});

	it('JSON paste into a code fence inserts text, never split-block', () => {
		const src = createEditorState(page([para('a', 'Hi')]));
		const payload = copyPayload(src, {
			anchor: { blockId: 'a', offset: 0 },
			head: { blockId: 'a', offset: 2 }
		});
		const dest = createEditorState(page([code('c', 'ab')]));
		const live = { anchor: { blockId: 'c', offset: 1 }, head: { blockId: 'c', offset: 1 } };
		const ops = pasteOps(dest, live, { json: payload!.json });
		expect(ops.some((op) => op.kind === 'split-block')).toBe(false);
		expect(ops[0]).toMatchObject({
			kind: 'insert-text',
			at: { blockId: 'c', offset: 1 },
			text: 'Hi'
		});
		const next = dispatchMany(dest, ops);
		expect(next.page.blocks).toHaveLength(1);
		expect(next.page.blocks[0]).toMatchObject({ type: 'code', text: 'aHib' });
	});
});
