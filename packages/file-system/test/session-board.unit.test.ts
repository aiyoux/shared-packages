import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSessionBoard } from '../src/sessionBoard.ts';
import { foreignSaveAction, mergeSessions, type OpenSession } from '../src/openSessions.ts';

function session(partial: Partial<OpenSession> & Pick<OpenSession, 'id' | 'updatedAt'>): OpenSession {
	return {
		kind: 'sketch',
		title: partial.id,
		dirty: false,
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

describe('first save across tabs', () => {
	it('drops the unsaved copy of a row another tab saved', () => {
		const unsaved = session({ id: 'a', title: 'Untitled', dirty: true, updatedAt: 5 });
		const saved = session({ id: 'a', fileId: 'file-1', title: 'Plan', updatedAt: 3 });
		for (const merged of [mergeSessions([unsaved], [saved]), mergeSessions([saved], [unsaved])]) {
			assert.equal(merged.length, 1);
			assert.equal(merged[0].fileId, 'file-1');
		}
	});

	it('drops it when the file row took the lesser id of two tabs', () => {
		const merged = mergeSessions(
			[session({ id: 'b', updatedAt: 5 }), session({ id: 'b', fileId: 'file-1', updatedAt: 3 })],
			[session({ id: 'a', fileId: 'file-1', updatedAt: 2 })]
		);
		assert.deepEqual(
			merged.map((row) => [row.id, row.fileId]),
			[['a', 'file-1']]
		);
	});

	it('the tab that had not heard converges, and publishes nothing back', () => {
		let storedA: string | null = null;
		const a = createSessionBoard({
			load: () => storedA,
			save: (json) => (storedA = json),
			tabGet: () => null,
			tabSet: () => {}
		});
		const row = a.note({ kind: 'sketch', title: 'Untitled', dirty: true });
		let storedB: string | null = storedA;
		const b = createSessionBoard({
			load: () => storedB,
			save: (json) => (storedB = json),
			tabGet: () => null,
			tabSet: () => {}
		});
		assert.equal(b.current().sessions.length, 1);

		a.note({ kind: 'sketch', title: 'Plan', fileId: 'file-1', sessionId: row.id, dirty: false });
		const result = b.absorb(storedA);
		assert.equal(result.publish, false);
		assert.deepEqual(
			b.current().sessions.map((s) => [s.id, s.fileId]),
			[[row.id, 'file-1']]
		);
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

describe('closing a session across tabs', () => {
	function tabs() {
		let shared: string | null = null;
		const make = () => {
			let tab: string | null = null;
			return createSessionBoard({
				load: () => shared,
				save: (json) => {
					shared = json;
				},
				tabGet: () => tab,
				tabSet: (id) => {
					tab = id;
				}
			});
		};
		return { make, raw: () => shared };
	}

	it('keeps a closed session closed when another tab still held it', () => {
		const t = tabs();
		const a = t.make();
		const row = a.note({ kind: 'diagram', app: 'diagrams', title: 'Plan', fileId: 'f1', connect: false });
		const b = t.make();
		assert.equal(b.current().sessions.length, 1);
		a.forget(row.id);
		const heard = b.absorb(t.raw());
		assert.deepEqual(heard.closed.map((s) => s.id), [row.id]);
		if (heard.publish) b.flush();
		a.absorb(t.raw());
		assert.equal(a.current().sessions.length, 0);
		assert.equal(b.current().sessions.length, 0);
	});

	it('drops a copy the other tab touched after the close, then converges', () => {
		const t = tabs();
		const a = t.make();
		const row = a.note({ kind: 'diagram', title: 'Plan', fileId: 'f1', now: 1 });
		const b = t.make();
		a.forget(row.id);
		const closedRaw = t.raw();
		// b edits before it hears of the close, and its write lands first.
		b.note({ kind: 'diagram', title: 'Plan', fileId: 'f1', dirty: true, now: Date.now() + 5000 });
		const bWrite = t.raw();
		a.absorb(bWrite);
		const heard = b.absorb(closedRaw);
		assert.equal(heard.closed.length, 1);
		b.flush();
		a.absorb(t.raw());
		assert.equal(a.current().sessions.length, 0);
		assert.equal(b.current().sessions.length, 0);
	});

	it('opens the same file again after a close', () => {
		const t = tabs();
		const a = t.make();
		const row = a.note({ kind: 'diagram', title: 'Plan', fileId: 'f1' });
		a.forget(row.id);
		const again = a.note({ kind: 'diagram', title: 'Plan', fileId: 'f1' });
		const b = t.make();
		assert.equal(b.current().sessions.length, 1);
		assert.equal(b.current().sessions[0]?.id, again.id);
	});
});
