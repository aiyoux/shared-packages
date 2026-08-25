import { plaintextOf, type Op } from '@shared-packages/kb-model';
import { describe, expect, it } from 'vitest';
import { beginComposition, commitComposition, snapshotComposition } from './composition.js';
import { applyRemoteOps, flushPendingRemotes, queueRemoteWhileComposing } from './remote.js';
import { applyEditorOps, createEditorState, dispatch, undo, type EditorState } from './state.js';
import { page, para } from './testFixtures.js';

function ed(blocks: Parameters<typeof page>[0]): EditorState {
	return createEditorState(page(blocks));
}

function insert(blockId: string, offset: number, text: string): Op {
	return { kind: 'insert-text', at: { blockId, offset }, text };
}

describe('IME queues remotes (D14)', () => {
	it('queues ALL remotes while composing and does not apply until flush', () => {
		let state = beginComposition(ed([para('p', 'hi'), para('q', 'yy')]));
		state = applyRemoteOps(state, [insert('q', 0, 'R')]);
		expect(plaintextOf(state.page.blocks[1])).toBe('yy');
		expect(state.pendingRemote).toEqual([insert('q', 0, 'R')]);
		expect(state.composing).toBe(true);
	});

	it('queues sibling insert/delete while composing and does not mutate the page until flush', () => {
		let state = beginComposition(ed([para('p', 'hi'), para('q', 'yy')]));
		state = applyRemoteOps(state, [
			{ kind: 'insert-block', afterId: 'p', block: para('r', 'sib') },
			{ kind: 'delete-block', id: 'p' }
		]);
		expect(state.page.blocks.map((b) => b.id)).toEqual(['p', 'q']);
		expect(state.pendingRemote).toHaveLength(2);
		expect(state.composing).toBe(true);
	});

	it('compositionend commits the local snapshot insert first, then remotes', () => {
		let state = beginComposition(ed([para('p', 'hi'), para('q', 'yy')]));
		const snap = snapshotComposition(state, state.selection);
		state = queueRemoteWhileComposing(state, [insert('q', 0, 'R'), insert('p', 0, 'X')]);
		expect(plaintextOf(state.page.blocks[0])).toBe('hi');
		expect(plaintextOf(state.page.blocks[1])).toBe('yy');

		const { ops } = commitComposition(state, snap, 'あ');
		state = applyEditorOps({ ...state, composing: false }, ops);
		expect(plaintextOf(state.page.blocks[0])).toBe('あhi');
		expect(plaintextOf(state.page.blocks[1])).toBe('yy');

		state = flushPendingRemotes(state);
		expect(plaintextOf(state.page.blocks[0])).toBe('Xあhi');
		expect(plaintextOf(state.page.blocks[1])).toBe('Ryy');
		expect(state.pendingRemote).toEqual([]);
	});
});

describe('remote apply vs undo (D18)', () => {
	it('does not push remotes onto the undo stack; Cmd-Z does not revert a remote', () => {
		let state = dispatch(ed([para('p', ''), para('q', '')]), insert('p', 0, 'A'));
		expect(plaintextOf(state.page.blocks[0])).toBe('A');
		state = applyRemoteOps(state, [insert('q', 0, 'B')]);
		expect(plaintextOf(state.page.blocks[1])).toBe('B');
		expect(state.undo).toHaveLength(1);

		state = undo(state);
		expect(plaintextOf(state.page.blocks[0])).toBe('');
		expect(plaintextOf(state.page.blocks[1])).toBe('B');
	});

	it('same-block undo no-ops after a remote (group dropped, does not revert remote)', () => {
		let state = dispatch(ed([para('x', 'aa'), para('y', 'bb')]), insert('x', 0, 'Z'));
		expect(plaintextOf(state.page.blocks[0])).toBe('Zaa');
		state = applyRemoteOps(state, [insert('x', 1, 'R')]);
		expect(plaintextOf(state.page.blocks[0])).toBe('ZRaa');
		expect(state.undo).toEqual([]);

		const after = undo(state);
		expect(after).toBe(state);
		expect(plaintextOf(after.page.blocks[0])).toBe('ZRaa');
		expect(plaintextOf(after.page.blocks[1])).toBe('bb');
	});

	it('undo of another block still works after a remote elsewhere', () => {
		let state = dispatch(ed([para('x', 'aa'), para('y', 'bb')]), insert('x', 0, 'Z'));
		state = applyRemoteOps(state, [insert('y', 0, 'Q')]);
		expect(state.undo).toHaveLength(1);
		state = undo(state);
		expect(plaintextOf(state.page.blocks[0])).toBe('aa');
		expect(plaintextOf(state.page.blocks[1])).toBe('Qbb');
	});
});
