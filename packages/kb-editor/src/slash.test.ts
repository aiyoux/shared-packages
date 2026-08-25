import { plaintextOf } from '@shared-packages/kb-model';
import { describe, expect, it } from 'vitest';
import { mapBeforeInput } from './beforeinput.js';
import { slashOps } from './slash.js';
import { createEditorState, dispatchMany } from './state.js';
import { page, para } from './testFixtures.js';

describe('slash convert', () => {
	it('maps /h1 /h2 /h3 /ul /ol /code', () => {
		expect(slashOps('p', '/h1')?.[0]).toMatchObject({
			kind: 'convert-block',
			to: 'heading',
			level: 1
		});
		expect(slashOps('p', '/h2')?.[0]).toMatchObject({ to: 'heading', level: 2 });
		expect(slashOps('p', '/h3')?.[0]).toMatchObject({ to: 'heading', level: 3 });
		expect(slashOps('p', '/ul')?.[0]).toMatchObject({ to: 'list_item', ordered: false });
		expect(slashOps('p', '/ol')?.[0]).toMatchObject({ to: 'list_item', ordered: true });
		expect(slashOps('p', '/code')?.[0]).toMatchObject({ to: 'code' });
		expect(slashOps('p', '/nope')).toBeNull();
		expect(slashOps('p', '/callout')?.some((op) => op.kind === 'convert-block')).toBe(false);
		expect(slashOps('p', '/toggle')?.[0]?.kind).toBe('insert-block');
	});

	it('insertText of space after /h1 converts and strips the command', () => {
		let state = createEditorState(page([para('p', '/h1')]));
		state = {
			...state,
			selection: { anchor: { blockId: 'p', offset: 3 }, head: { blockId: 'p', offset: 3 } }
		};
		const result = mapBeforeInput(state, { inputType: 'insertText', data: ' ' }, state.selection);
		expect(result.ops[0]?.kind).toBe('convert-block');
		state = dispatchMany(state, result.ops);
		expect(state.page.blocks[0].type).toBe('heading');
		expect(plaintextOf(state.page.blocks[0])).toBe('');
	});

	it('Enter on /ul converts to an unordered list_item', () => {
		let state = createEditorState(page([para('p', '/ul')]));
		const result = mapBeforeInput(state, { inputType: 'insertParagraph', data: null }, state.selection);
		state = dispatchMany(state, result.ops);
		expect(state.page.blocks[0]).toMatchObject({ type: 'list_item', ordered: false });
	});
});
