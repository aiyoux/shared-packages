import { describe, it, expect } from 'vitest';
import { createEditorState, dispatch, remapIds, undo } from './state.js';
import type { Block, KbPage, Op } from '@shared-packages/doc-model';

const span = (text: string) => [{ type: 'text' as const, text, marks: [] }];
const para = (id: string, text = 'hello'): Block => ({ id, type: 'paragraph', content: span(text) });

function page(blocks: Block[], id = 'temp:page'): KbPage {
	return {
		format: 'kb',
		id,
		title: 'T',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		children: ['a-child-slug'],
		blocks
	};
}

/**
 * The remap is what lets one editor sit on a record backend, where the server
 * assigns block ids but the caret needs one immediately. By the time the real
 * id arrives, the temp id is in the page, the caret, both history stacks and
 * any held remote ops — so the test is that none of them keep it.
 */
describe('remapIds', () => {
	const map = new Map([
		['temp:a', 'records:1'],
		['temp:b', 'records:2'],
		['temp:page', 'records:page']
	]);

	it('rewrites page, blocks and the caret together', () => {
		const state = createEditorState(page([para('temp:a'), para('temp:b')]));
		const out = remapIds(state, map);
		expect(out.page.id).toBe('records:page');
		expect(out.page.blocks.map((b) => b.id)).toEqual(['records:1', 'records:2']);
		expect(out.selection.anchor.blockId).toBe('records:1');
		expect(out.selection.head.blockId).toBe('records:1');
	});

	it('rewrites the undo stack, so undo after an accept still works', () => {
		let state = createEditorState(page([para('temp:a')]));
		state = dispatch(state, { kind: 'insert-text', at: { blockId: 'temp:a', offset: 0 }, text: 'X' });
		expect(state.undo.length).toBe(1);

		const out = remapIds(state, map);
		const stackIds = JSON.stringify(out.undo);
		expect(stackIds).not.toContain('temp:a');
		expect(stackIds).toContain('records:1');

		// And the rewritten history still applies cleanly against the new page.
		const undone = undo(out);
		expect(undone.page.blocks[0].id).toBe('records:1');
		expect(undone.redo.length).toBe(1);
	});

	it('rewrites the redo stack', () => {
		let state = createEditorState(page([para('temp:a')]));
		state = dispatch(state, { kind: 'insert-text', at: { blockId: 'temp:a', offset: 0 }, text: 'X' });
		state = undo(state);
		expect(state.redo.length).toBe(1);
		const out = remapIds(state, map);
		expect(JSON.stringify(out.redo)).not.toContain('temp:a');
	});

	it('rewrites blockFocus and held remote ops', () => {
		const base = createEditorState(page([para('temp:a')]));
		const held: Op[] = [{ kind: 'delete-block', id: 'temp:b' }];
		const out = remapIds({ ...base, blockFocus: 'temp:a', pendingRemote: held }, map);
		expect(out.blockFocus).toBe('records:1');
		expect(JSON.stringify(out.pendingRemote)).not.toContain('temp:b');
	});

	it('leaves an unmapped id alone rather than blanking it', () => {
		const base = createEditorState(page([para('records:already')], 'records:page'));
		const out = remapIds({ ...base, blockFocus: 'records:already' }, map);
		expect(out.blockFocus).toBe('records:already');
		expect(out.page.blocks[0].id).toBe('records:already');
	});

	it('is a no-op for an empty map, by identity', () => {
		const state = createEditorState(page([para('temp:a')]));
		expect(remapIds(state, new Map())).toBe(state);
	});

	it('does not mutate the state it was given', () => {
		const state = createEditorState(page([para('temp:a')]));
		remapIds(state, map);
		expect(state.page.id).toBe('temp:page');
		expect(state.page.blocks[0].id).toBe('temp:a');
	});

	it('never rewrites the child-page slug list', () => {
		const state = createEditorState(page([para('temp:a')]));
		expect(remapIds(state, map).page.children).toEqual(['a-child-slug']);
	});

	/**
	 * The realistic sequence: split mints an id, the user keeps typing into the
	 * new block while the create is in flight, then the real id lands.
	 */
	it('survives a split-then-type burst before the id arrives', () => {
		let state = createEditorState(page([para('temp:a', 'hello world')]));
		state = dispatch(state, {
			kind: 'split-block',
			at: { blockId: 'temp:a', offset: 5 },
			newId: 'temp:b'
		});
		for (const ch of ['h', 'i']) {
			state = dispatch(state, {
				kind: 'insert-text',
				at: { blockId: 'temp:b', offset: 0 },
				text: ch
			});
		}
		const out = remapIds(state, map);
		const everything = JSON.stringify({
			page: out.page,
			selection: out.selection,
			undo: out.undo,
			redo: out.redo
		});
		expect(everything).not.toContain('temp:');
		expect(out.page.blocks.map((b) => b.id)).toEqual(['records:1', 'records:2']);
	});
});
