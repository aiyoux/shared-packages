import { describe, it, expect } from 'vitest';
import { createEditorState, dispatch, redo, undo } from './state.js';
import type { Block, DocBody } from '@shared-packages/doc-model';

/**
 * The editor has to run on a document with no KB envelope, because that is
 * what the record backend has: a page id, a title, and blocks. If any of this
 * quietly required `format` / `createdAt` / `children`, the second adapter
 * could not mount the shared editor at all.
 */
type RecordDoc = DocBody & { pageId: string };

const span = (text: string) => [{ type: 'text' as const, text, marks: [] }];
const para = (id: string, text = 'hello'): Block => ({ id, type: 'paragraph', content: span(text) });

const recordDoc = (blocks: Block[]): RecordDoc => ({
	pageId: 'records:page',
	title: 'Untitled',
	blocks
});

describe('EditorState on a record-backed document', () => {
	it('creates state and keeps the foreign envelope field', () => {
		const state = createEditorState(recordDoc([para('records:1')]));
		expect(state.page.pageId).toBe('records:page');
		expect(state.selection.anchor.blockId).toBe('records:1');
		expect(state.undo).toEqual([]);
	});

	it('does not invent KB envelope fields it has no business inventing', () => {
		const state = createEditorState(recordDoc([para('records:1')]));
		expect('format' in state.page).toBe(false);
		expect('children' in state.page).toBe(false);
		expect('createdAt' in state.page).toBe(false);
	});

	it('dispatches, undoes and redoes', () => {
		let state = createEditorState(recordDoc([para('records:1', 'ab')]));
		state = dispatch(state, {
			kind: 'insert-text',
			at: { blockId: 'records:1', offset: 2 },
			text: 'c'
		});
		expect(state.undo).toHaveLength(1);

		const typed = state;
		state = undo(state);
		expect(state.page.pageId).toBe('records:page');
		state = redo(state);
		expect(JSON.stringify(state.page.blocks)).toBe(JSON.stringify(typed.page.blocks));
	});

	it('splits and merges, carrying the envelope through both', () => {
		let state = createEditorState(recordDoc([para('records:1', 'ab')]));
		state = dispatch(state, {
			kind: 'split-block',
			at: { blockId: 'records:1', offset: 1 },
			newId: 'temp:new'
		});
		expect(state.page.blocks.map((b) => b.id)).toEqual(['records:1', 'temp:new']);
		expect(state.page.pageId).toBe('records:page');

		state = dispatch(state, { kind: 'merge-block', keepId: 'records:1', dropId: 'temp:new' });
		expect(state.page.blocks).toHaveLength(1);
		expect(state.page.pageId).toBe('records:page');
	});

	it('normalizes an empty document into one paragraph without an envelope', () => {
		const state = createEditorState(recordDoc([]));
		expect(state.page.blocks).toHaveLength(1);
		expect(state.page.blocks[0].type).toBe('paragraph');
		expect(state.page.pageId).toBe('records:page');
	});
});
