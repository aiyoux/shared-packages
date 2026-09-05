import { describe, expect, it } from 'vitest';
import { mapKeydown } from './keymap.js';
import { createEditorState } from './state.js';
import { cell, divider, page, para, row, table } from './testFixtures.js';

describe('keymap', () => {
	it('is a no-op while composing (does not preventDefault)', () => {
		const state = { ...createEditorState(page([para('p', 'ab')])), composing: true };
		const result = mapKeydown(
			state,
			{ key: 'b', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
			{ anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 2 } }
		);
		expect(result.preventDefault).toBe(false);
		expect(result.ops).toEqual([]);
	});

	it('Cmd/Ctrl-B and Cmd/Ctrl-I format the live range', () => {
		const state = createEditorState(page([para('p', 'ab')]));
		const live = { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 2 } };
		const bold = mapKeydown(
			state,
			{ key: 'b', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
			live
		);
		expect(bold.preventDefault).toBe(true);
		expect(bold.ops[0]).toMatchObject({ kind: 'format-range', mark: { type: 'bold' }, on: true });
		const italic = mapKeydown(
			state,
			{ key: 'i', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
			live
		);
		expect(italic.ops[0]).toMatchObject({ kind: 'format-range', mark: { type: 'italic' } });
	});

	it('Cmd-Z / Shift-Z are undo/redo', () => {
		const state = createEditorState(page([para('p', 'ab')]));
		const live = state.selection;
		expect(
			mapKeydown(state, { key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }, live)
				.history
		).toBe('undo');
		expect(
			mapKeydown(state, { key: 'z', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }, live)
				.history
		).toBe('redo');
	});

	it('Shift+Enter inserts a hard break (\\n) in a paragraph', () => {
		const state = createEditorState(page([para('p', 'ab')]));
		const live = { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } };
		const result = mapKeydown(
			state,
			{ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false },
			live
		);
		expect(result.preventDefault).toBe(true);
		expect(result.ops).toEqual([{ kind: 'insert-text', at: { blockId: 'p', offset: 1 }, text: '\n' }]);
	});

	it('Shift+Enter inserts a hard break inside a table cell instead of cell nav', () => {
		const state = createEditorState(
			page([table('t', [row('r1', [cell('c1', 'x'), cell('c2', 'y')])])])
		);
		const live = { anchor: { blockId: 'c1', offset: 1 }, head: { blockId: 'c1', offset: 1 } };
		const result = mapKeydown(
			state,
			{ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false },
			live
		);
		expect(result.preventDefault).toBe(true);
		expect(result.ops).toEqual([{ kind: 'insert-text', at: { blockId: 'c1', offset: 1 }, text: '\n' }]);
	});

	it('Shift+Enter on an atomic block falls through (beforeinput insertLineBreak owns the fallback)', () => {
		const state = createEditorState(page([para('p', 'ab'), divider('d')]));
		const live = { anchor: { blockId: 'd', offset: 0 }, head: { blockId: 'd', offset: 0 } };
		const result = mapKeydown(
			state,
			{ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false },
			live
		);
		expect(result.preventDefault).toBe(false);
		expect(result.ops).toEqual([]);
	});

	it('plain Enter is unchanged (no shiftKey branch; beforeinput owns split)', () => {
		const state = createEditorState(page([para('p', 'ab')]));
		const live = { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } };
		const result = mapKeydown(
			state,
			{ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
			live
		);
		expect(result.preventDefault).toBe(false);
		expect(result.ops).toEqual([]);
	});
});
