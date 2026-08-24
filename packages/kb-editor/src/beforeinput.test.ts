import { plaintextOf } from '@shared-packages/kb-model';
import { describe, expect, it } from 'vitest';
import { mapBeforeInput } from './beforeinput.js';
import { createEditorState, dispatch, dispatchMany } from './state.js';
import { code, divider, heading, item, page, para } from './testFixtures.js';

function applyMapped(
	blocks: Parameters<typeof page>[0],
	inputType: string,
	data: string | null,
	selection?: { blockId: string; offset: number }
) {
	let state = createEditorState(page(blocks));
	if (selection) {
		state = {
			...state,
			selection: { anchor: { ...selection }, head: { ...selection } }
		};
	}
	const result = mapBeforeInput(state, { inputType, data }, state.selection);
	if (result.ops.length === 1) state = dispatch(state, result.ops[0]);
	else if (result.ops.length > 1) state = dispatchMany(state, result.ops);
	return { result, state };
}

describe('beforeinput mapping', () => {
	it('insertText → insert-text', () => {
		const { result, state } = applyMapped([para('p', '')], 'insertText', 'x');
		expect(result.preventDefault).toBe(true);
		expect(result.ops[0]).toMatchObject({ kind: 'insert-text', text: 'x' });
		expect(plaintextOf(state.page.blocks[0])).toBe('x');
	});

	it('deleteContentBackward expands one UTF-16 unit, including emoji', () => {
		const { state } = applyMapped([para('p', 'a👍b')], 'deleteContentBackward', null, {
			blockId: 'p',
			offset: 3
		});
		expect(plaintextOf(state.page.blocks[0])).toBe('ab');
	});

	it('Backspace at offset 0 with no previous block is a no-op', () => {
		const { result, state } = applyMapped([para('p', 'hi')], 'deleteContentBackward', null, {
			blockId: 'p',
			offset: 0
		});
		expect(result.ops).toEqual([]);
		expect(plaintextOf(state.page.blocks[0])).toBe('hi');
	});

	it('Backspace at 0 merges with the previous paragraph', () => {
		const { result, state } = applyMapped(
			[para('a', 'ab'), para('b', 'cd')],
			'deleteContentBackward',
			null,
			{ blockId: 'b', offset: 0 }
		);
		expect(result.ops[0]).toEqual({ kind: 'merge-block', keepId: 'a', dropId: 'b' });
		expect(state.page.blocks).toHaveLength(1);
		expect(plaintextOf(state.page.blocks[0])).toBe('abcd');
	});

	it('Backspace at 0 on empty list_item unwraps to paragraph when previous is not a list', () => {
		const { result, state } = applyMapped(
			[para('p', 'x'), item('i', '')],
			'deleteContentBackward',
			null,
			{ blockId: 'i', offset: 0 }
		);
		expect(result.ops[0]).toMatchObject({ kind: 'convert-block', id: 'i', to: 'paragraph' });
		expect(state.page.blocks[1].type).toBe('paragraph');
	});

	it('Enter splits a paragraph', () => {
		const { result, state } = applyMapped([para('p', 'hello')], 'insertParagraph', null, {
			blockId: 'p',
			offset: 2
		});
		expect(result.ops[0]?.kind).toBe('split-block');
		expect(state.page.blocks).toHaveLength(2);
		expect(plaintextOf(state.page.blocks[0])).toBe('he');
		expect(plaintextOf(state.page.blocks[1])).toBe('llo');
	});

	it('Enter in a list_item splits to another list_item', () => {
		const { state } = applyMapped([item('i', 'ab', false)], 'insertParagraph', null, {
			blockId: 'i',
			offset: 1
		});
		expect(state.page.blocks).toHaveLength(2);
		expect(state.page.blocks[0]).toMatchObject({ type: 'list_item', ordered: false });
		expect(state.page.blocks[1]).toMatchObject({ type: 'list_item', ordered: false });
		expect(plaintextOf(state.page.blocks[0])).toBe('a');
		expect(plaintextOf(state.page.blocks[1])).toBe('b');
	});

	it('Enter on an empty list_item converts to paragraph (unwrap)', () => {
		const { result, state } = applyMapped([item('i', '')], 'insertParagraph', null);
		expect(result.ops[0]).toMatchObject({ kind: 'convert-block', to: 'paragraph' });
		expect(state.page.blocks[0].type).toBe('paragraph');
	});

	it('Enter in code inserts a newline except on an empty last line', () => {
		const mid = applyMapped([code('c', 'ab')], 'insertParagraph', null, { blockId: 'c', offset: 1 });
		expect(mid.result.ops[0]).toEqual({
			kind: 'insert-text',
			at: { blockId: 'c', offset: 1 },
			text: '\n'
		});
		expect(plaintextOf(mid.state.page.blocks[0])).toBe('a\nb');

		const end = applyMapped([code('c', 'ab\n')], 'insertParagraph', null, { blockId: 'c', offset: 3 });
		expect(end.result.ops[0]?.kind).toBe('split-block');
		expect(end.state.page.blocks[0]).toMatchObject({ type: 'code', text: 'ab' });
		expect(end.state.page.blocks[1].type).toBe('paragraph');
	});

	it('Enter at end of heading inserts a paragraph after', () => {
		const { result, state } = applyMapped([heading('h', 'Title', 2)], 'insertParagraph', null, {
			blockId: 'h',
			offset: 5
		});
		expect(result.ops[0]?.kind).toBe('insert-block');
		expect(state.page.blocks[1].type).toBe('paragraph');
		expect(state.page.blocks[0]).toMatchObject({ type: 'heading', level: 2 });
	});

	it('formatBold applies format-range', () => {
		let state = createEditorState(page([para('p', 'hi')]));
		state = {
			...state,
			selection: { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 2 } }
		};
		const result = mapBeforeInput(state, { inputType: 'formatBold', data: null }, state.selection);
		expect(result.ops[0]).toMatchObject({ kind: 'format-range', mark: { type: 'bold' }, on: true });
		state = dispatch(state, result.ops[0]);
		const block = state.page.blocks[0];
		if (block.type === 'paragraph') expect(block.content[0].marks).toEqual([{ type: 'bold' }]);
	});

	it('unlisted non-composition types preventDefault and ignore', () => {
		const { result, state } = applyMapped([para('p', 'x')], 'formatUnderline', null);
		expect(result.preventDefault).toBe(true);
		expect(result.ops).toEqual([]);
		expect(plaintextOf(state.page.blocks[0])).toBe('x');
	});

	it('Backspace on a focused divider deletes the block', () => {
		let state = createEditorState(page([para('p', 'x'), divider('d')]));
		state = {
			...state,
			selection: { anchor: { blockId: 'd', offset: 0 }, head: { blockId: 'd', offset: 0 } },
			blockFocus: 'd'
		};
		const result = mapBeforeInput(
			state,
			{ inputType: 'deleteContentBackward', data: null },
			state.selection
		);
		expect(result.ops[0]).toEqual({ kind: 'delete-block', id: 'd' });
	});

	it('historyUndo is reported as undo, not an Op', () => {
		const state = createEditorState(page([para('p', 'x')]));
		const result = mapBeforeInput(state, { inputType: 'historyUndo', data: null }, state.selection);
		expect(result.history).toBe('undo');
		expect(result.preventDefault).toBe(true);
		expect(result.ops).toEqual([]);
	});

	it('deleteByCut preventDefaults and emits no ops (onCut owns the delete)', () => {
		let state = createEditorState(page([para('p', 'abcd')]));
		state = {
			...state,
			selection: { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 3 } }
		};
		const result = mapBeforeInput(state, { inputType: 'deleteByCut', data: null }, state.selection);
		expect(result.preventDefault).toBe(true);
		expect(result.ops).toEqual([]);
		expect(plaintextOf(state.page.blocks[0])).toBe('abcd');
	});

	it('insertFromDrop preventDefaults and emits no ops (host drop owns paste)', () => {
		const state = createEditorState(page([para('p', 'ab')]));
		const result = mapBeforeInput(state, { inputType: 'insertFromDrop', data: 'x' }, state.selection);
		expect(result.preventDefault).toBe(true);
		expect(result.ops).toEqual([]);
	});

	it('backwards selection + insertText deletes then inserts at document-order start', () => {
		let state = createEditorState(page([para('p', 'abcd')]));
		const live = { anchor: { blockId: 'p', offset: 3 }, head: { blockId: 'p', offset: 1 } };
		const result = mapBeforeInput(state, { inputType: 'insertText', data: 'X' }, live);
		expect(result.ops[0]).toMatchObject({ kind: 'delete-range' });
		expect(result.ops[1]).toMatchObject({
			kind: 'insert-text',
			at: { blockId: 'p', offset: 1 },
			text: 'X'
		});
		state = dispatchMany(state, result.ops);
		expect(plaintextOf(state.page.blocks[0])).toBe('aXd');
	});

	it('select-all /h1 + Enter deletes then splits; does not slash-convert leftover', () => {
		let state = createEditorState(page([para('p', '/h1')]));
		const live = { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 3 } };
		const result = mapBeforeInput(state, { inputType: 'insertParagraph', data: null }, live);
		expect(result.ops[0]?.kind).toBe('delete-range');
		expect(result.ops.some((op) => op.kind === 'convert-block')).toBe(false);
		state = dispatchMany(state, result.ops);
		expect(state.page.blocks[0].type).toBe('paragraph');
		expect(plaintextOf(state.page.blocks[0])).toBe('');
	});

	it('returns no ops when the caret names a missing block', () => {
		const state = createEditorState(page([para('p', 'x')]));
		const live = { anchor: { blockId: 'gone', offset: 0 }, head: { blockId: 'gone', offset: 0 } };
		expect(mapBeforeInput(state, { inputType: 'insertText', data: 'z' }, live).ops).toEqual([]);
		expect(mapBeforeInput(state, { inputType: 'insertParagraph', data: null }, live).ops).toEqual([]);
		expect(mapBeforeInput(state, { inputType: 'deleteContentForward', data: null }, live).ops).toEqual(
			[]
		);
	});
});
