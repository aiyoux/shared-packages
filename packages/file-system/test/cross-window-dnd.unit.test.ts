import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	setCrossWindowDrag,
	getCrossWindowDrag,
	clearCrossWindowDrag,
	type CrossWindowDragSession
} from '../src/ui/crossWindowDnd.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

const stubDriver: ExplorerDriver = {
	id: 'local',
	connectionId: undefined,
	capabilities: {
		supportsMkdir: true,
		supportsRename: true,
		supportsMove: true,
		supportsDragOut: false,
		supportsSiblingOrder: false,
		canDownload: true
	},
	list: async () => ({ entries: [], truncated: false }),
	getPath: async () => [],
	mkdir: async () => ({ id: 'x', kind: 'folder', name: 'x' }),
	rename: async () => ({ id: 'x', kind: 'folder', name: 'x' }),
	move: async () => {},
	delete: async () => {},
	writeFile: async () => ({ id: 'x', kind: 'file', name: 'x' })
};

const stubEntries: ExplorerEntry[] = [
	{ id: 'f1', kind: 'file', name: 'a.txt', size: 10 },
	{ id: 'f2', kind: 'file', name: 'b.txt', size: 20 }
];

describe('crossWindowDnd', () => {
	beforeEach(() => clearCrossWindowDrag());

	it('getCrossWindowDrag returns null when no drag is active', () => {
		assert.equal(getCrossWindowDrag(), null);
	});

	it('setCrossWindowDrag stores the session', () => {
		const session: CrossWindowDragSession = {
			sourceDriver: stubDriver,
			sourceEntries: stubEntries,
			selectedIds: ['f1', 'f2']
		};
		setCrossWindowDrag(session);
		const got = getCrossWindowDrag();
		assert.notEqual(got, null);
		assert.deepEqual(got!.selectedIds, ['f1', 'f2']);
		assert.equal(got!.sourceDriver.id, 'local');
		assert.equal(got!.sourceEntries.length, 2);
	});

	it('clearCrossWindowDrag clears the session', () => {
		setCrossWindowDrag({
			sourceDriver: stubDriver,
			sourceEntries: stubEntries,
			selectedIds: ['f1']
		});
		assert.notEqual(getCrossWindowDrag(), null);
		clearCrossWindowDrag();
		assert.equal(getCrossWindowDrag(), null);
	});

	it('setCrossWindowDrag overwrites a previous session', () => {
		setCrossWindowDrag({
			sourceDriver: stubDriver,
			sourceEntries: stubEntries,
			selectedIds: ['f1']
		});
		setCrossWindowDrag({
			sourceDriver: stubDriver,
			sourceEntries: stubEntries,
			selectedIds: ['f2']
		});
		assert.deepEqual(getCrossWindowDrag()!.selectedIds, ['f2']);
	});
});
