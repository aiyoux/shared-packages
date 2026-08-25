import { createEmptyPage, plaintext, plaintextOf, schemaCompatible, type Op } from '@shared-packages/kb-model';
import { describe, expect, it } from 'vitest';
import { beginComposition, commitComposition, shouldProject, snapshotComposition } from './composition.js';
import { project, syncView } from './project.js';
import { applyRemoteOps, flushPendingRemotes, replaceFromSnapshot } from './remote.js';
import { applyEditorOps, createEditorState, dispatch, setSelection, undo } from './state.js';
import { page, para } from './testFixtures.js';

function insert(blockId: string, offset: number, text: string): Op {
	return { kind: 'insert-text', at: { blockId, offset }, text };
}

describe('C7a editor goldens', () => {
	it('1. two carets: A splits above B, B stays in the new block (#205)', () => {
		let state = createEditorState(page([para('A', '0123456789ABCD')]));
		state = setSelection(state, {
			anchor: { blockId: 'A', offset: 10 },
			head: { blockId: 'A', offset: 10 }
		});
		state = applyRemoteOps(state, [
			{ kind: 'split-block', at: { blockId: 'A', offset: 4 }, newId: 'new' }
		]);
		expect(state.page.blocks[0].id).toBe('A');
		expect(plaintextOf(state.page.blocks[0])).toBe('0123');
		expect(state.page.blocks[1].id).toBe('new');
		expect(plaintextOf(state.page.blocks[1])).toBe('456789ABCD');
		expect(state.selection.anchor).toEqual({ blockId: 'new', offset: 6 });
		expect(state.selection.head).toEqual({ blockId: 'new', offset: 6 });
	});

	it('2. B composing CJK, A types other block, preedit survives until compositionend', () => {
		const host = document.createElement('div');
		document.body.append(host);
		let state = createEditorState(page([para('p', 'hi'), para('q', 'yy')]));
		state = setSelection(state, {
			anchor: { blockId: 'q', offset: 0 },
			head: { blockId: 'q', offset: 0 }
		});
		project(host, state.page);
		state = beginComposition(state);
		const q = host.querySelector('[data-block-id="q"]') as HTMLElement;
		const text = [...q.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		text.data = 'あyy';
		expect(shouldProject(state)).toBe(false);
		expect(state.composing).toBe(true);

		state = applyRemoteOps(state, [insert('p', 0, 'X')]);
		expect(plaintextOf(state.page.blocks[0])).toBe('hi');
		expect(plaintextOf(state.page.blocks[1])).toBe('yy');
		expect(state.pendingRemote).toEqual([insert('p', 0, 'X')]);
		syncView(host, state);
		expect(text.data).toBe('あyy');
		expect(host.querySelector('[data-block-id="p"]')?.textContent).toBe('hi');

		const snap = snapshotComposition(state, state.selection);
		const { ops } = commitComposition(state, snap, 'あ');
		state = applyEditorOps({ ...state, composing: false }, ops);
		state = flushPendingRemotes(state);
		expect(plaintextOf(state.page.blocks[0])).toBe('Xhi');
		expect(plaintextOf(state.page.blocks[1])).toBe('あyy');
		host.remove();
	});

	it("3. A deletes B's block, B snaps, no throw", () => {
		let state = createEditorState(page([para('a', 'aa'), para('b', 'bb'), para('c', 'cc')]));
		state = setSelection(state, {
			anchor: { blockId: 'b', offset: 1 },
			head: { blockId: 'b', offset: 1 }
		});
		expect(() => {
			state = applyRemoteOps(state, [{ kind: 'delete-block', id: 'b' }]);
		}).not.toThrow();
		expect(state.page.blocks.map((b) => b.id)).toEqual(['a', 'c']);
		expect(state.selection.anchor).toEqual({ blockId: 'c', offset: 0 });
	});

	it('4. Cmd-Z on A does not revert B', () => {
		let state = dispatch(createEditorState(page([para('p', ''), para('q', '')])), insert('p', 0, 'A'));
		state = applyRemoteOps(state, [insert('q', 0, 'B')]);
		state = undo(state);
		expect(plaintextOf(state.page.blocks[0])).toBe('');
		expect(plaintextOf(state.page.blocks[1])).toBe('B');
	});

	it('4b. A and B type in the same block; A Cmd-Z no-ops (group dropped)', () => {
		let state = dispatch(createEditorState(page([para('x', 'aa')])), insert('x', 0, 'Z'));
		state = applyRemoteOps(state, [insert('x', 1, 'R')]);
		expect(state.undo).toEqual([]);
		const after = undo(state);
		expect(after).toBe(state);
		expect(plaintextOf(after.page.blocks[0])).toBe('ZRaa');
	});

	it('5. Join: remote non-empty discards local seed', () => {
		const seed = createEmptyPage({ id: 'page-1', title: 'seed' });
		const seedId = seed.blocks[0]!.id;
		let state = createEditorState(seed);
		state = replaceFromSnapshot(page([para('p', 'hello from host')]));
		expect(plaintext(state.page)).toContain('hello from host');
		expect(state.page.blocks.map((b) => b.id)).toEqual(['p']);
		expect(state.page.blocks[0]!.id).not.toBe(seedId);
		expect(state.undo).toEqual([]);
	});

	it('6. two v2 clients on a v1 file write; v1 client + v2 snapshot is read-only', () => {
		expect(schemaCompatible(2, 2, 1)).toBe(true);
		expect(schemaCompatible(1, 2, 2)).toBe(false);
	});

	it('sibling insert-block while composing is queued; composing Text identity survives syncView', () => {
		const host = document.createElement('div');
		document.body.append(host);
		let state = createEditorState(page([para('p', 'hi'), para('q', 'yy')]));
		state = setSelection(state, {
			anchor: { blockId: 'q', offset: 0 },
			head: { blockId: 'q', offset: 0 }
		});
		project(host, state.page);
		state = beginComposition(state);
		const q = host.querySelector('[data-block-id="q"]') as HTMLElement;
		const text = [...q.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		text.data = 'あyy';

		const sibling: Op = { kind: 'insert-block', afterId: 'p', block: para('r', 'sib') };
		state = applyRemoteOps(state, [sibling]);
		expect(state.page.blocks.map((b) => b.id)).toEqual(['p', 'q']);
		expect(state.pendingRemote).toEqual([sibling]);
		syncView(host, state);
		expect(text.data).toBe('あyy');
		expect(text.parentElement).toBe(q);
		expect(host.querySelector('[data-block-id="r"]')).toBeNull();

		const snap = snapshotComposition(state, state.selection);
		const { ops } = commitComposition(state, snap, 'あ');
		state = applyEditorOps({ ...state, composing: false }, ops);
		state = flushPendingRemotes(state);
		expect(plaintextOf(state.page.blocks.find((b) => b.id === 'q')!)).toBe('あyy');
		expect(state.page.blocks.map((b) => b.id)).toEqual(['p', 'r', 'q']);
		expect(plaintextOf(state.page.blocks.find((b) => b.id === 'r')!)).toBe('sib');
		host.remove();
	});

	it('sibling delete-block and split-block while composing stay queued', () => {
		let state = beginComposition(createEditorState(page([para('a', 'aa'), para('b', 'bb'), para('c', 'cc')])));
		state = setSelection(state, {
			anchor: { blockId: 'c', offset: 0 },
			head: { blockId: 'c', offset: 0 }
		});
		state = applyRemoteOps(state, [
			{ kind: 'delete-block', id: 'b' },
			{ kind: 'split-block', at: { blockId: 'a', offset: 1 }, newId: 'a2' }
		]);
		expect(state.page.blocks.map((b) => b.id)).toEqual(['a', 'b', 'c']);
		expect(state.pendingRemote).toHaveLength(2);
		expect(state.composing).toBe(true);

		state = applyEditorOps({ ...state, composing: false }, []);
		state = flushPendingRemotes(state);
		expect(state.page.blocks.map((b) => b.id)).toEqual(['a', 'a2', 'c']);
		expect(plaintextOf(state.page.blocks[0])).toBe('a');
		expect(plaintextOf(state.page.blocks[1])).toBe('a');
	});
});
