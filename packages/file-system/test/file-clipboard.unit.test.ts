import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	FILE_CLIPBOARD_TYPE, fileClipboardFromText, fileClipboardPayload, sameClipboardSource, markClipboardFileMoved
} from '../src/ui/fileClipboard.ts';
import type { ExplorerDriver } from '../src/ui/explorerDriver.ts';

const payload = {
	mode: 'cut', clipboardId: 'clip-1', sourceDriverId: 'b2', sourceConnectionId: 'bucket-1',
	sourceParentId: 'folder/', ids: ['folder/data.json'],
	entries: [{ id: 'folder/data.json', name: 'data.json', kind: 'file' }]
};

describe('file clipboard', () => {
	it('round-trips system envelopes and restores the parent in legacy snapshots', () => {
		const restored = fileClipboardFromText(JSON.stringify({ type: FILE_CLIPBOARD_TYPE, data: payload }));
		assert.equal(restored?.entries[0].parentId, 'folder/');
		assert.equal(restored?.mode, 'cut');
		assert.equal(restored?.clipboardId, 'clip-1');
	});

	it('rejects malformed or incomplete external file references', () => {
		for (const invalid of [null, {}, { ...payload, mode: 'delete' }, { ...payload, ids: [42] },
			{ ...payload, sourceDriverId: undefined }, { ...payload, entries: [] },
			{ ...payload, entries: [null] }, { ...payload, entries: [{ id: 'folder/data.json', kind: 'folder' }] }]) {
			assert.equal(fileClipboardPayload(invalid), null);
		}
		assert.equal(fileClipboardFromText('hello'), null);
		assert.equal(fileClipboardFromText(JSON.stringify({ type: 'text/plain', data: payload })), null);
	});

	it('keeps a completed cut empty rather than reviving clipboard history', () => {
		assert.deepEqual(fileClipboardPayload({ ...payload, ids: [], entries: [] })?.ids, []);
	});

	it('distinguishes connections sharing the same driver type', () => {
		const restored = fileClipboardPayload(payload)!;
		assert.equal(sameClipboardSource(restored, { id: 'b2', connectionId: 'bucket-1' } as ExplorerDriver), true);
		assert.equal(sameClipboardSource(restored, { id: 'b2', connectionId: 'bucket-2' } as ExplorerDriver), false);
	});

	it('does not replay a completed cut from a stale system clipboard', () => {
		const cut = fileClipboardPayload({ ...payload, clipboardId: 'finished-cut' })!;
		markClipboardFileMoved(cut, cut.ids[0]);
		assert.deepEqual(fileClipboardPayload(cut)?.ids, []);
		assert.deepEqual(fileClipboardPayload({ ...cut, mode: 'copy' })?.ids, payload.ids);
	});
});
