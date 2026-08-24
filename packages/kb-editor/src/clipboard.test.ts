import { plaintextOf } from '@shared-packages/kb-model';
import { describe, expect, it } from 'vitest';
import { copyPayload, KB_CLIPBOARD_MIME, parseSlice, pasteOps, stripHtml } from './clipboard.js';
import { createEditorState, dispatchMany } from './state.js';
import { page, para } from './testFixtures.js';

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
});
