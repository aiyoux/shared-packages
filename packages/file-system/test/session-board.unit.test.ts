import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSessionBoard } from '../src/sessionBoard.ts';
import { foreignSaveAction, mergeSessions, type OpenSession } from '../src/openSessions.ts';

function session(partial: Partial<OpenSession> & Pick<OpenSession, 'id' | 'updatedAt'>): OpenSession {
	return {
		kind: 'sketch',
		title: partial.id,
		dirty: false,
		remote: false,
		...partial
	};
}

describe('session list merge', () => {
	it('keeps one id for a file and the later fields', () => {
		const merged = mergeSessions(
			[session({ id: 'b', fileId: 'file-1', title: 'Old', dirty: true, updatedAt: 1 })],
			[session({ id: 'a', fileId: 'file-1', title: 'New', dirty: false, updatedAt: 2 })]
		);
		assert.equal(merged.length, 1);
		assert.equal(merged[0]?.id, 'a');
		assert.equal(merged[0]?.title, 'New');
		assert.equal(merged[0]?.dirty, false);
	});

	it('does not drop a session the other tab has not heard of', () => {
		const merged = mergeSessions(
			[session({ id: 'a', fileId: 'file-1', updatedAt: 1 }), session({ id: 'c', fileId: 'file-2', updatedAt: 3 })],
			[session({ id: 'a', fileId: 'file-1', title: 'Saved', dirty: false, updatedAt: 2 })]
		);
		assert.equal(merged.length, 2);
		assert.equal(merged.find((s) => s.fileId === 'file-2')?.id, 'c');
	});
});

describe('session board', () => {
	it('keeps this tab connected when another tab publishes its list', () => {
		const shared = new Map<string, string>();
		const tab = new Map<string, string>();
		const board = createSessionBoard({
			load: () => shared.get('k') ?? null,
			save: (json) => shared.set('k', json),
			tabGet: () => tab.get('k') ?? null,
			tabSet: (id) => {
				if (id) tab.set('k', id);
				else tab.delete('k');
			}
		});
		const mine = board.remember({ kind: 'sketch', title: 'Mine', fileId: 'file-1', dirty: true, now: 1 });
		const other = createSessionBoard({
			load: () => shared.get('k') ?? null,
			save: (json) => shared.set('k', json),
			tabGet: () => null,
			tabSet: () => {}
		});
		other.remember({ kind: 'sketch', title: 'Theirs', fileId: 'file-2', dirty: false, now: 2 });
		const absorbed = board.absorb(shared.get('k') ?? null);
		assert.equal(absorbed.changed, true);
		assert.equal(board.current().connectedId, mine.id);
		assert.equal(board.current().sessions.length, 2);
		assert.equal(tab.get('k'), mine.id);
	});

	it('drops one session by id, including an unsaved row', () => {
		const board = createSessionBoard({
			load: () => null,
			save: () => {},
			tabGet: () => null,
			tabSet: () => {}
		});
		const saved = board.note({ kind: 'diagram', app: 'diagrams', title: 'Plan', fileId: 'file-1', now: 1 });
		const unsaved = board.note({ kind: 'text', app: 'text', title: 'Note', id: 'scratch-1', now: 2 });
		board.forget(unsaved.id);
		assert.equal(board.current().sessions.length, 1);
		assert.equal(board.current().sessions[0]?.id, saved.id);
		board.forget(saved.id);
		assert.equal(board.current().sessions.length, 0);
	});
});

describe('foreign save', () => {
	it('clears a replicated document, reloads a clean one, and keeps a dirty one', () => {
		assert.equal(foreignSaveAction({ replicated: true, uiDirty: true }), 'clear-dirty');
		assert.equal(foreignSaveAction({ replicated: false, uiDirty: false }), 'reload');
		assert.equal(foreignSaveAction({ replicated: false, uiDirty: true }), 'keep');
	});
});
