import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalClass, isRemoteClass } from '../src/ui/explorerDriver.ts';
import {
	assertCopyAcrossAllowed,
	canShowCopyAcross,
	copyAcross,
	CopyAcrossError,
	destParentFromDropEvent,
	FE_EXPLORER_IDS_MIME,
	idsFromExplorerDataTransfer,
	idsFromExplorerDragTarget,
	parseExplorerDragIds
} from '../src/ui/copyAcross.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';
import { listTransfers, resetTransferRegistryForTests } from '../src/transferRegistry.ts';

describe('isLocalClass / isRemoteClass', () => {
	it('local-class = local | memory | disk', () => {
		assert.equal(isLocalClass('local'), true);
		assert.equal(isLocalClass('memory'), true);
		assert.equal(isLocalClass('disk'), true);
		assert.equal(isLocalClass('b2'), false);
		assert.equal(isLocalClass('rclone'), false);
		assert.equal(isLocalClass('monitor'), false);
		assert.equal(isLocalClass('other'), false);
	});

	it('remote-class = b2 | rclone | monitor | peer-fs', () => {
		assert.equal(isRemoteClass('b2'), true);
		assert.equal(isRemoteClass('rclone'), true);
		assert.equal(isRemoteClass('monitor'), true);
		assert.equal(isRemoteClass('peer-fs'), true);
		assert.equal(isRemoteClass('local'), false);
		assert.equal(isRemoteClass('memory'), false);
		assert.equal(isRemoteClass('disk'), false);
	});

	it('matrix: remote↔remote both remote-class', () => {
		assert.equal(isRemoteClass('b2') && isRemoteClass('rclone'), true);
		assert.equal(isRemoteClass('b2') && isRemoteClass('monitor'), true);
		assert.equal(isLocalClass('local') || isLocalClass('b2'), true);
		assert.equal(isLocalClass('b2') || isLocalClass('rclone'), false);
	});

	it('copy-across chrome: at least one local-class pane', () => {
		assert.equal(canShowCopyAcross('b2', 'monitor'), false);
		assert.equal(canShowCopyAcross('b2', 'b2'), false);
		assert.equal(canShowCopyAcross('disk', 'b2'), true);
		assert.equal(canShowCopyAcross('memory', 'monitor'), true);
		assert.equal(canShowCopyAcross('local', 'monitor'), true);
		assert.equal(canShowCopyAcross('disk', 'memory'), true);
		assert.equal(canShowCopyAcross('local', 'peer-fs'), true);
		assert.equal(canShowCopyAcross('b2', 'peer-fs'), false);
	});

	it('assertCopyAcrossAllowed blocks only remote↔remote', () => {
		assert.throws(() => assertCopyAcrossAllowed('b2', 'monitor'), /remote/i);
		assert.throws(() => assertCopyAcrossAllowed('monitor', 'rclone'), /remote/i);
		assert.throws(() => assertCopyAcrossAllowed('b2', 'peer-fs'), /remote/i);
		assertCopyAcrossAllowed('disk', 'b2');
		assertCopyAcrossAllowed('b2', 'local');
		assertCopyAcrossAllowed('monitor', 'memory');
		assertCopyAcrossAllowed('local', 'disk');
		assertCopyAcrossAllowed('local', 'peer-fs');
		assertCopyAcrossAllowed('disk', 'peer-fs');
	});
});

describe('cross-pane drag payload', () => {
	it('parseExplorerDragIds splits and trims', () => {
		assert.deepEqual(parseExplorerDragIds(' a, b , ,c '), ['a', 'b', 'c']);
		assert.deepEqual(parseExplorerDragIds(''), []);
	});

	it('idsFromExplorerDataTransfer prefers the explorer mime', () => {
		const dt = {
			getData(type: string) {
				if (type === FE_EXPLORER_IDS_MIME) return 'id1,id2';
				if (type === 'text/plain') return 'ignored';
				return '';
			}
		} as unknown as DataTransfer;
		assert.deepEqual(idsFromExplorerDataTransfer(dt), ['id1', 'id2']);
	});

	it('destParentFromDropEvent uses a folder row id, else fallback', () => {
		const folder = {
			getAttribute(name: string) {
				if (name === 'data-fe-kind') return 'folder';
				if (name === 'data-fe-row-id') return 'fld1';
				return null;
			},
			closest(sel: string) {
				return sel === '[data-fe-row-id]' ? folder : null;
			}
		};
		const name = { closest: (sel: string) => (sel === '[data-fe-row-id]' ? folder : null) };
		assert.equal(destParentFromDropEvent({ target: name as unknown as EventTarget }, 'root'), 'fld1');

		const file = {
			getAttribute(name: string) {
				if (name === 'data-fe-kind') return 'file';
				if (name === 'data-fe-row-id') return 'f1';
				return null;
			},
			closest(sel: string) {
				return sel === '[data-fe-row-id]' ? file : null;
			}
		};
		assert.equal(destParentFromDropEvent({ target: file as unknown as EventTarget }, 'open'), 'open');
		assert.equal(destParentFromDropEvent({ target: null }, 'open'), 'open');
	});

	it('idsFromExplorerDragTarget reads the row, or the selected set', () => {
		const selected = {
			getAttribute(name: string) {
				return name === 'data-fe-row-id' ? 'a' : null;
			}
		};
		const list = {
			querySelectorAll(sel: string) {
				return sel === '.fe-row.selected[data-fe-row-id]' ? [selected] : [];
			}
		};
		const row = {
			getAttribute(name: string) {
				if (name === 'data-fe-row-id') return 'a';
				return null;
			},
			closest(sel: string) {
				if (sel === '[data-fe-row-id]') return row;
				if (sel === '[data-testid="fe-list"]') return list;
				return null;
			}
		};
		assert.deepEqual(idsFromExplorerDragTarget(row as unknown as EventTarget), ['a']);
		assert.deepEqual(idsFromExplorerDragTarget(null), []);
	});
});

describe('copyAcross truncated folder', () => {
	it('aborts instead of silently dropping children past the list cap', async () => {
		const folder: ExplorerEntry = {
			id: 'big/',
			parentId: null,
			name: 'big',
			kind: 'folder'
		};
		const source = {
			id: 'disk',
			capabilities: { supportsMkdir: true },
			async list() {
				return { entries: [], truncated: true };
			}
		} as unknown as ExplorerDriver;
		const dest = {
			id: 'local',
			capabilities: { supportsMkdir: true },
			async mkdir() {
				return { id: 'copied/', parentId: null, name: 'big', kind: 'folder' };
			}
		} as unknown as ExplorerDriver;
		await assert.rejects(
			() =>
				copyAcross({
					sourceDriver: source,
					destDriver: dest,
					selectedIds: [folder.id],
					sourceEntries: [folder],
					destParentId: null
				}),
			(e: unknown) => e instanceof CopyAcrossError && e.code === 'COPY_ACROSS_TRUNCATED'
		);
	});

	it('reports copy progress through the transfer registry', async () => {
		resetTransferRegistryForTests();
		const file: ExplorerEntry = {
			id: 'remote.bin',
			parentId: null,
			name: 'remote.bin',
			kind: 'file',
			size: 4
		};
		const ticks: number[] = [];
		const source = {
			id: 'b2',
			capabilities: {},
			async download(_id: string, opts?: { onProgress?: (n: number, t?: number) => void }) {
				opts?.onProgress?.(2, 4);
				ticks.push(2);
				opts?.onProgress?.(4, 4);
				ticks.push(4);
				return new Blob([new Uint8Array([1, 2, 3, 4])]);
			}
		} as unknown as ExplorerDriver;
		const written: string[] = [];
		const dest = {
			id: 'memory',
			capabilities: { supportsMkdir: false },
			async writeFile(_parent: string | null, f: File) {
				written.push(f.name);
				return { id: 'mem-1', parentId: null, name: f.name, kind: 'file' };
			}
		} as unknown as ExplorerDriver;
		const n = await copyAcross({
			sourceDriver: source,
			destDriver: dest,
			selectedIds: [file.id],
			sourceEntries: [file],
			destParentId: null
		});
		assert.equal(n, 1);
		assert.deepEqual(written, ['remote.bin']);
		assert.ok(ticks.includes(4));
		const copies = listTransfers().filter((t) => t.direction === 'copying');
		assert.equal(copies.length, 1);
		assert.equal(copies[0]!.done, true);
		assert.equal(copies[0]!.status, 'done');
		assert.equal(copies[0]!.transferred, 4);
	});

	it('allows disk → b2 file copy and rejects copy into monitor', async () => {
		resetTransferRegistryForTests();
		const file: ExplorerEntry = {
			id: 'note.txt',
			parentId: null,
			name: 'note.txt',
			kind: 'file',
			size: 2
		};
		const disk = {
			id: 'disk',
			capabilities: { supportsMkdir: true },
			async readBlob() {
				return new Blob(['hi']);
			},
			async download() {
				return new Blob(['hi']);
			}
		} as unknown as ExplorerDriver;
		const b2 = {
			id: 'b2',
			capabilities: { supportsUpload: true },
			async upload(_parent: string | null, f: File) {
				return { id: f.name, parentId: null, name: f.name, kind: 'file' };
			}
		} as unknown as ExplorerDriver;
		const mon = {
			id: 'monitor',
			capabilities: { supportsUpload: false }
		} as unknown as ExplorerDriver;
		assert.equal(
			await copyAcross({
				sourceDriver: disk,
				destDriver: b2,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: null
			}),
			1
		);
		await assert.rejects(
			() =>
				copyAcross({
					sourceDriver: disk,
					destDriver: mon,
					selectedIds: [file.id],
					sourceEntries: [file],
					destParentId: null
				}),
			(e: unknown) => e instanceof CopyAcrossError && e.code === 'COPY_ACROSS_DEST_READONLY'
		);
	});
});
