import { plaintextOf } from '@shared-packages/kb-model';
import { describe, expect, it } from 'vitest';
import { copyPayload, cutOps, KB_CLIPBOARD_MIME, parseSlice, pasteOps, stripHtml } from './clipboard.js';
import { createEditorState, dispatchMany } from './state.js';
import { code, page, para } from './testFixtures.js';

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

	it('text/plain paste inserts at the caret', () => {
		const state = createEditorState(page([para('p', 'ab')]));
		const live = { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } };
		const next = dispatchMany(state, pasteOps(state, live, { plain: 'X' }));
		expect(plaintextOf(next.page.blocks[0])).toBe('aXb');
	});

	it('cut emits a single delete-range', () => {
		const live = { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 3 } };
		expect(cutOps(live)).toEqual([{ kind: 'delete-range', range: live }]);
		expect(cutOps({ anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } })).toEqual([]);
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
