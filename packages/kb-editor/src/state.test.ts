import { plaintextOf } from '@shared-packages/kb-model';
import { describe, expect, it } from 'vitest';
import { code, heading, item, page, para } from './testFixtures.js';
import {
	createEditorState,
	dispatch,
	dispatchMany,
	redo,
	undo,
	UNDO_CAP,
	type EditorState
} from './state.js';

function ed(blocks: Parameters<typeof page>[0]): EditorState {
	return createEditorState(page(blocks));
}

describe('dispatch insert/delete', () => {
	it('inserts text and places the caret after it', () => {
		const state = ed([para('p', 'hi')]);
		const next = dispatch(state, {
			kind: 'insert-text',
			at: { blockId: 'p', offset: 2 },
			text: '!'
		});
		expect(plaintextOf(next.page.blocks[0])).toBe('hi!');
		expect(next.selection).toEqual({
			anchor: { blockId: 'p', offset: 3 },
			head: { blockId: 'p', offset: 3 }
		});
		expect(next.undo).toHaveLength(1);
		expect(next.redo).toEqual([]);
	});

	it('deletes a range and leaves the caret at the start', () => {
		const state = ed([para('p', 'abcd')]);
		const next = dispatch(state, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 3 } }
		});
		expect(plaintextOf(next.page.blocks[0])).toBe('ad');
		expect(next.selection.anchor).toEqual({ blockId: 'p', offset: 1 });
	});

	it('survives in-memory across later dispatches (undo stack is kept)', () => {
		let state = ed([para('p', '')]);
		state = dispatch(state, { kind: 'insert-text', at: { blockId: 'p', offset: 0 }, text: 'a' });
		state = dispatch(state, { kind: 'insert-text', at: { blockId: 'p', offset: 1 }, text: 'b' });
		expect(plaintextOf(state.page.blocks[0])).toBe('ab');
		expect(state.undo).toHaveLength(2);
		state = undo(state);
		expect(plaintextOf(state.page.blocks[0])).toBe('a');
		state = undo(state);
		expect(plaintextOf(state.page.blocks[0])).toBe('');
		state = redo(state);
		expect(plaintextOf(state.page.blocks[0])).toBe('a');
	});

	it('caps the linear undo stack at 200', () => {
		let state = ed([para('p', '')]);
		for (let i = 0; i < UNDO_CAP + 25; i++) {
			const offset = plaintextOf(state.page.blocks[0]).length;
			state = dispatch(state, { kind: 'insert-text', at: { blockId: 'p', offset }, text: 'x' });
		}
		expect(state.undo.length).toBe(UNDO_CAP);
		expect(plaintextOf(state.page.blocks[0]).length).toBe(UNDO_CAP + 25);
	});

	it('does not put set-children on the editor undo stack', () => {
		const state = ed([para('p', 'x')]);
		const next = dispatch(state, { kind: 'set-children', children: ['child'] });
		expect(next.page.children).toEqual(['child']);
		expect(next.undo).toEqual([]);
	});
});

describe('dispatch split/merge/format', () => {
	it('split-block moves the caret to the new block', () => {
		const state = ed([para('p', 'hello')]);
		const next = dispatch(state, {
			kind: 'split-block',
			at: { blockId: 'p', offset: 2 },
			newId: 'n'
		});
		expect(next.page.blocks.map((b) => b.id)).toEqual(['p', 'n']);
		expect(plaintextOf(next.page.blocks[0])).toBe('he');
		expect(plaintextOf(next.page.blocks[1])).toBe('llo');
		expect(next.selection.anchor).toEqual({ blockId: 'n', offset: 0 });
	});

	it('merge-block restores the caret at keep length', () => {
		const state = ed([para('a', 'ab'), para('b', 'cd')]);
		const next = dispatch(state, { kind: 'merge-block', keepId: 'a', dropId: 'b' });
		expect(next.page.blocks).toHaveLength(1);
		expect(plaintextOf(next.page.blocks[0])).toBe('abcd');
		expect(next.selection.anchor).toEqual({ blockId: 'a', offset: 2 });
	});

	it('format-range keeps the selection', () => {
		const range = { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 2 } };
		const state = { ...ed([para('p', 'hi')]), selection: range };
		const next = dispatch(state, { kind: 'format-range', range, mark: { type: 'bold' }, on: true });
		expect(next.selection).toEqual(range);
		const block = next.page.blocks[0];
		expect(block.type).toBe('paragraph');
		if (block.type === 'paragraph') expect(block.content[0].marks).toEqual([{ type: 'bold' }]);
	});

	it('dispatchMany is one undo group', () => {
		let state = ed([para('p', 'abcd')]);
		state = dispatchMany(state, [
			{
				kind: 'delete-range',
				range: { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 3 } }
			},
			{ kind: 'insert-text', at: { blockId: 'p', offset: 1 }, text: 'X' }
		]);
		expect(plaintextOf(state.page.blocks[0])).toBe('aXd');
		expect(state.undo).toHaveLength(1);
		state = undo(state);
		expect(plaintextOf(state.page.blocks[0])).toBe('abcd');
	});

	it('convert-block clamps offset', () => {
		const state = {
			...ed([heading('h', 'Hi', 1)]),
			selection: { anchor: { blockId: 'h', offset: 2 }, head: { blockId: 'h', offset: 2 } }
		};
		const next = dispatch(state, { kind: 'convert-block', id: 'h', to: 'divider' });
		expect(next.page.blocks[0].type).toBe('divider');
		expect(next.selection.anchor).toEqual({ blockId: 'h', offset: 0 });
		expect(next.blockFocus).toBe('h');
	});

	it('list_item split keeps ordered', () => {
		const state = ed([item('i', 'ab', true)]);
		const next = dispatch(state, {
			kind: 'split-block',
			at: { blockId: 'i', offset: 1 },
			newId: 'j'
		});
		expect(next.page.blocks[0]).toMatchObject({ type: 'list_item', ordered: true });
		expect(next.page.blocks[1]).toMatchObject({ type: 'list_item', ordered: true, id: 'j' });
	});

	it('cross-block delete-range joins leftovers', () => {
		const state = ed([para('a', 'hello'), para('b', 'world')]);
		const next = dispatch(state, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 2 }, head: { blockId: 'b', offset: 2 } }
		});
		expect(next.page.blocks).toHaveLength(1);
		expect(plaintextOf(next.page.blocks[0])).toBe('herld');
		expect(next.selection.anchor).toEqual({ blockId: 'a', offset: 2 });
	});

	it('cross-block format-range bolds only the slice', () => {
		const range = { anchor: { blockId: 'a', offset: 3 }, head: { blockId: 'b', offset: 2 } };
		const state = { ...ed([para('a', 'hello'), para('b', 'world')]), selection: range };
		const next = dispatch(state, { kind: 'format-range', range, mark: { type: 'bold' }, on: true });
		const a = next.page.blocks[0];
		const b = next.page.blocks[1];
		expect(a.type).toBe('paragraph');
		expect(b.type).toBe('paragraph');
		if (a.type === 'paragraph' && b.type === 'paragraph') {
			expect(a.content.map((s) => [s.text, s.marks.map((m) => m.type)])).toEqual([
				['hel', []],
				['lo', ['bold']]
			]);
			expect(b.content.map((s) => [s.text, s.marks.map((m) => m.type)])).toEqual([
				['wo', ['bold']],
				['rld', []]
			]);
		}
	});

	it('code insert-text of newline stays in the fence', () => {
		const state = ed([code('c', 'a')]);
		const next = dispatch(state, {
			kind: 'insert-text',
			at: { blockId: 'c', offset: 1 },
			text: '\n'
		});
		expect(next.page.blocks[0]).toMatchObject({ type: 'code', text: 'a\n' });
		expect(next.selection.anchor.offset).toBe(2);
	});
});
