import { describe, expect, it } from 'vitest';
import { mapKeydown } from './keymap.js';
import { createEditorState } from './state.js';
import { page, para } from './testFixtures.js';

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
});
