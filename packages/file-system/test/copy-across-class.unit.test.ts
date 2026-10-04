import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	EXPLORER_DOWNLOAD_MAX_BYTES,
	explorerThumbsAreEager,
	isLocalClass,
	isRemoteClass
} from '../src/ui/explorerDriver.ts';
import {
	canServerCopy,
	classify,
	copyAcross,
	CopyAcrossError,
	describeCopyAcrossPath,
	isDualPhaseCopy,
	dataTransferHasOsFiles,
	destParentFromDropEvent,
	FE_EXPLORER_IDS_MIME,
	filesFromDataTransfer,
	idsFromExplorerDataTransfer,
	idsFromExplorerDragTarget,
	parseExplorerDragIds,
	parseExplorerDragPayload,
	explorerDragFromDataTransfer
} from '../src/ui/copyAcross.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';
import { listFileOpProgress as listTransfers, resetFileOpsForTest } from '../src/services/fileOps.ts';
import type { StartOp, OpHandle } from '../src/services/ops.ts';
function resetTransferRegistryForTests() {
 resetFileOpsForTest(async (input: StartOp): Promise<OpHandle> => ({ id: input.id!, signal: new AbortController().signal, progress() {}, done: async () => {}, fail: async () => {}, cancelled: async () => {}, onCancelRequest() { return () => {}; } }));
}
resetTransferRegistryForTests();

describe('isLocalClass / isRemoteClass', () => {
	it('local-class = local | memory | disk', () => {
		assert.equal(isLocalClass('local'), true);
		assert.equal(isLocalClass('memory'), true);
		assert.equal(isLocalClass('disk'), true);
		assert.equal(isLocalClass('b2'), false);
		assert.equal(isLocalClass('peer-fs'), false);
		assert.equal(isLocalClass('monitor'), false);
		assert.equal(isLocalClass('other'), false);
	});

	it('remote-class = b2 | monitor | peer-fs', () => {
		assert.equal(isRemoteClass('b2'), true);
		assert.equal(isRemoteClass('monitor'), true);
		assert.equal(isRemoteClass('peer-fs'), true);
		assert.equal(isRemoteClass('local'), false);
		assert.equal(isRemoteClass('memory'), false);
		assert.equal(isRemoteClass('disk'), false);
	});

	it('matrix: remote↔remote both remote-class', () => {
		assert.equal(isRemoteClass('b2') && isRemoteClass('peer-fs'), true);
		assert.equal(isRemoteClass('b2') && isRemoteClass('monitor'), true);
		assert.equal(isLocalClass('local') || isLocalClass('b2'), true);
		assert.equal(isLocalClass('b2') || isLocalClass('peer-fs'), false);
	});

	it('eager thumbs: local VFS and monitor host thumbs, not B2', () => {
		assert.equal(explorerThumbsAreEager({ id: 'local' }), true);
		assert.equal(explorerThumbsAreEager({ id: 'memory' }), true);
		assert.equal(explorerThumbsAreEager({ id: 'b2' }), false);
		assert.equal(explorerThumbsAreEager({ id: 'peer-fs' }), false);
		assert.equal(explorerThumbsAreEager({ id: 'monitor' }), false);
		assert.equal(
			explorerThumbsAreEager({
				id: 'monitor',
				thumbUrl: async () => ({ url: 'http://127.0.0.1/thumb' })
			}),
			true
		);
	});

});

describe('cross-pane drag payload', () => {
	it('detects OS file drags vs explorer row ids', () => {
		const os = { types: ['Files'], files: { length: 0 } } as unknown as DataTransfer;
		const explorer = {
			types: [FE_EXPLORER_IDS_MIME],
			files: { length: 0 }
		} as unknown as DataTransfer;
		assert.equal(dataTransferHasOsFiles(os), true);
		assert.equal(dataTransferHasOsFiles(explorer), false);
		const listed = {
			types: ['Files'],
			files: [{ name: 'a.txt' } as File]
		} as unknown as DataTransfer;
		assert.deepEqual(
			filesFromDataTransfer(listed).map((f) => f.name),
			['a.txt']
		);
	});

	it('parseExplorerDragIds splits and trims', () => {
		assert.deepEqual(parseExplorerDragIds(' a, b , ,c '), ['a', 'b', 'c']);
		assert.deepEqual(parseExplorerDragIds(''), []);
	});

	it('parseExplorerDragPayload accepts JSON {driverId,ids} and legacy comma lists', () => {
		assert.deepEqual(parseExplorerDragPayload('{"driverId":"monitor","ids":["/tmp/a","/tmp/b"]}'), {
			driverId: 'monitor',
			ids: ['/tmp/a', '/tmp/b']
		});
		assert.deepEqual(parseExplorerDragPayload('id1,id2'), { ids: ['id1', 'id2'] });
		assert.deepEqual(parseExplorerDragPayload(''), { ids: [] });
		assert.deepEqual(parseExplorerDragIds('{"driverId":"local","ids":["a","b"]}'), ['a', 'b']);
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

	it('explorerDragFromDataTransfer reads JSON mime and falls back to text/plain', () => {
		const jsonDt = {
			getData(type: string) {
				if (type === FE_EXPLORER_IDS_MIME)
					return JSON.stringify({ driverId: 'local', ids: ['n1', 'n2'] });
				if (type === 'text/plain') return 'n1,n2';
				return '';
			}
		} as unknown as DataTransfer;
		assert.deepEqual(explorerDragFromDataTransfer(jsonDt), {
			driverId: 'local',
			ids: ['n1', 'n2']
		});
		assert.deepEqual(idsFromExplorerDataTransfer(jsonDt), ['n1', 'n2']);

		const legacyDt = {
			getData(type: string) {
				if (type === FE_EXPLORER_IDS_MIME) return '';
				if (type === 'text/plain') return 'a,b';
				return '';
			}
		} as unknown as DataTransfer;
		assert.deepEqual(explorerDragFromDataTransfer(legacyDt), { ids: ['a', 'b'] });
	});

	it('destParentFromDropEvent uses a folder row id, else fallback', () => {
		const folder = {
			getAttribute(name: string) {
				if (name === 'data-fe-kind') return 'folder';
				if (name === 'data-fe-row-id') return 'fld1';
				return null;
			},
			closest(sel: string) {
				if (sel === '[data-fe-drop-parent]') return null;
				return sel === '[data-fe-row-id]' ? folder : null;
			}
		};
		const name = {
			closest(sel: string) {
				if (sel === '[data-fe-drop-parent]') return null;
				return sel === '[data-fe-row-id]' ? folder : null;
			}
		};
		assert.equal(destParentFromDropEvent({ target: name as unknown as EventTarget }, 'root'), 'fld1');

		const treeFolder = {
			getAttribute(name: string) {
				return name === 'data-fe-drop-parent' ? 'tree-fld' : null;
			},
			closest(sel: string) {
				return sel === '[data-fe-drop-parent]' ? treeFolder : null;
			}
		};
		assert.equal(
			destParentFromDropEvent({ target: treeFolder as unknown as EventTarget }, 'root'),
			'tree-fld'
		);

		const file = {
			getAttribute(name: string) {
				if (name === 'data-fe-kind') return 'file';
				if (name === 'data-fe-row-id') return 'f1';
				return null;
			},
			closest(sel: string) {
				if (sel === '[data-fe-drop-parent]') return null;
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

	it('copies a local folder through the VFS folder copy once', async () => {
		resetTransferRegistryForTests();
		const folder: ExplorerEntry = { id: 'source', parentId: null, name: 'source', kind: 'folder' };
		let copies = 0;
		const local = {
			id: 'local',
			capabilities: { supportsMkdir: true },
			async list() { return { entries: [folder], truncated: false }; },
			async copy(id: string, parentId: string | null) {
				assert.equal(id, folder.id);
				assert.equal(parentId, 'destination');
				copies++;
				return { ...folder, id: 'copy', parentId };
			}
		} as unknown as ExplorerDriver;
		await copyAcross({
			sourceDriver: local,
			destDriver: local,
			selectedIds: [folder.id],
			sourceEntries: [folder],
			destParentId: 'destination'
		});
		assert.equal(copies, 1);
		const progress = listTransfers().find((t) => t.name === 'source');
		assert.equal(progress?.entryKind, 'folder');
		assert.equal(progress?.destParentId, 'destination');
	});

	it('copyAcross uses the live list name, not a stale sourceEntries snapshot', async () => {
		const stale: ExplorerEntry = {
			id: 'note',
			parentId: null,
			name: 'old.txt',
			kind: 'file',
			size: 1
		};
		const source = {
			id: 'local',
			capabilities: {},
			async list() {
				return {
					entries: [{ ...stale, name: 'renamed.txt' }],
					truncated: false
				};
			},
			async readBlob() {
				return new Blob([new Uint8Array([1])]);
			}
		} as unknown as ExplorerDriver;
		const written: string[] = [];
		const dest = {
			id: 'monitor',
			capabilities: { supportsMkdir: true },
			async writeFile(_parent: string | null, f: File) {
				written.push(f.name);
				return { id: f.name, parentId: null, name: f.name, kind: 'file' };
			}
		} as unknown as ExplorerDriver;
		await copyAcross({
			sourceDriver: source,
			destDriver: dest,
			selectedIds: [stale.id],
			sourceEntries: [stale],
			destParentId: null
		});
		assert.deepEqual(written, ['renamed.txt']);
	});

	it('resets progress to 0 before dest.upload so VFS→B2 is not 100% during the PUT', async () => {
		resetTransferRegistryForTests();
		const file: ExplorerEntry = {
			id: 'clip.bin',
			parentId: null,
			name: 'clip.bin',
			kind: 'file',
			size: 4
		};
		const source = {
			id: 'local',
			capabilities: {},
			async download() {
				return new Blob([new Uint8Array([1, 2, 3, 4])]);
			}
		} as unknown as ExplorerDriver;
		const seen: number[] = [];
		const dest = {
			id: 'b2',
			capabilities: { supportsUpload: true },
			async upload(
				_parent: string | null,
				f: File,
				opts?: { onProgress?: (pct: number) => void }
			) {
				seen.push(listTransfers().find((t) => t.direction === 'copying')?.transferred ?? -1);
				opts?.onProgress?.(0.5);
				seen.push(listTransfers().find((t) => t.direction === 'copying')?.transferred ?? -1);
				opts?.onProgress?.(1);
				return { id: f.name, parentId: null, name: f.name, kind: 'file' as const };
			}
		} as unknown as ExplorerDriver;
		await copyAcross({
			sourceDriver: source,
			destDriver: dest,
			selectedIds: [file.id],
			sourceEntries: [file],
			destParentId: null
		});
		assert.deepEqual(seen, [0, 2]);
		const copies = listTransfers().filter((t) => t.direction === 'copying');
		assert.equal(copies[0]!.transferred, 4);
		assert.equal(copies[0]!.done, true);
	});

	it('aborts dest.upload when copyAcross is cancelled', async () => {
		resetTransferRegistryForTests();
		const file: ExplorerEntry = {
			id: 'clip.bin',
			parentId: null,
			name: 'clip.bin',
			kind: 'file',
			size: 4
		};
		const ac = new AbortController();
		const source = {
			id: 'local',
			capabilities: {},
			async download() {
				return new Blob([new Uint8Array([1, 2, 3, 4])]);
			}
		} as unknown as ExplorerDriver;
		const dest = {
			id: 'monitor',
			capabilities: { supportsUpload: true },
			async upload(
				_parent: string | null,
				_f: File,
				opts?: { signal?: AbortSignal; onProgress?: (pct: number) => void }
			) {
				opts?.onProgress?.(0.05);
				ac.abort();
				if (opts?.signal?.aborted) {
					const e = new Error('aborted');
					e.name = 'AbortError';
					throw e;
				}
			}
		} as unknown as ExplorerDriver;
		await assert.rejects(
			() =>
				copyAcross({
					sourceDriver: source,
					destDriver: dest,
					selectedIds: [file.id],
					sourceEntries: [file],
					destParentId: null,
					signal: ac.signal
				}),
			(e: unknown) => e instanceof Error && e.name === 'AbortError'
		);
		const copies = listTransfers().filter((t) => t.direction === 'copying');
		assert.equal(copies[0]!.status, 'cancelled');
	});

	it('same B2 connection server-copies via the API and is not dual-phase', async () => {
		resetTransferRegistryForTests();
		const file: ExplorerEntry = {
			id: 'photos/a.jpg',
			parentId: 'photos/',
			name: 'a.jpg',
			kind: 'file',
			size: 12
		};
		const copied: Array<{ id: string; parent: string | null }> = [];
		const left = {
			id: 'b2',
			connectionId: 'b2:acct',
			endpointKey: 'b2:key::bucket',
			capabilities: { supportsUpload: true, supportsCopy: true },
			async download() {
				throw new Error('must not download when both panes are the same B2');
			}
		} as unknown as ExplorerDriver;
		const right = {
			id: 'b2',
			connectionId: 'b2:acct',
			endpointKey: 'b2:key::bucket',
			capabilities: { supportsUpload: true, supportsCopy: true },
			async copy(id: string, parent: string | null) {
				copied.push({ id, parent });
			},
			async download() {
				throw new Error('must not download when both panes are the same B2');
			}
		} as unknown as ExplorerDriver;
		assert.equal(canServerCopy(left, right), true);
		assert.equal(isDualPhaseCopy(left, right), false);
		const path = describeCopyAcrossPath(left, right, { source: 'B2 · photos', dest: 'B2 · photos' });
		assert.equal(path.kind, 'server');
		assert.match(path.summary, /Server copy/i);
		assert.equal(
			await copyAcross({
				sourceDriver: left,
				destDriver: right,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: 'archive/'
			}),
			1
		);
		assert.deepEqual(copied, [{ id: 'photos/a.jpg', parent: 'archive/' }]);
		assert.equal(listTransfers().some((t) => t.id.endsWith(':remote')), false);
	});

	it('same monitor connection server-copies without a download hop', async () => {
		resetTransferRegistryForTests();
		const file: ExplorerEntry = {
			id: 'shot.png',
			parentId: null,
			name: 'shot.png',
			kind: 'file',
			size: 200 * 1024 * 1024
		};
		const copied: string[] = [];
		const mon = {
			id: 'monitor',
			connectionId: 'monitor:p1',
			endpointKey: 'monitor:http://127.0.0.1:8300',
			capabilities: { supportsUpload: true, supportsCopy: true },
			async copy(id: string) {
				copied.push(id);
			}
		} as unknown as ExplorerDriver;
		assert.equal(canServerCopy(mon, mon), true);
		assert.equal(isDualPhaseCopy(mon, mon), false);
		assert.equal(
			await copyAcross({
				sourceDriver: mon,
				destDriver: mon,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: 'dest/'
			}),
			1
		);
		assert.deepEqual(copied, ['shot.png']);
		const copies = listTransfers().filter((t) => t.direction === 'copying');
		assert.equal(copies.length, 1);
		assert.equal(copies[0]!.done, true);
		assert.ok(!copies[0]!.id.endsWith(':remote'));
	});

	it('distinct remotes report stacked :remote + :wire legs', async () => {
		resetTransferRegistryForTests();
		const file: ExplorerEntry = {
			id: 'clip.wav',
			parentId: null,
			name: 'clip.wav',
			kind: 'file',
			size: 3
		};
		const b2 = {
			id: 'b2',
			connectionId: 'b2:a',
			endpointKey: 'b2:key::bucket-a',
			capabilities: { supportsUpload: true },
			async download(_id: string, opts?: { onProgress?: (n: number, t?: number) => void }) {
				opts?.onProgress?.(3, 3);
				return new Blob(['abc']);
			}
		} as unknown as ExplorerDriver;
		const uploaded: string[] = [];
		const rc = {
			id: 'peer-fs',
			connectionId: 'peer-fs:other',
			endpointKey: 'peer-fs:drive::/',
			capabilities: { supportsUpload: true },
			async upload(_parent: string | null, f: File, opts?: { onProgress?: (pct: number) => void }) {
				opts?.onProgress?.(1);
				uploaded.push(f.name);
				return { id: f.name, parentId: null, name: f.name, kind: 'file' };
			}
		} as unknown as ExplorerDriver;
		assert.equal(isDualPhaseCopy(b2, rc), true);
		const path = describeCopyAcrossPath(b2, rc, { source: 'B2 · shots', dest: 'Peer · drive' });
		assert.equal(path.kind, 'dual-phase');
		assert.match(path.detail, /confirm/i);
		const direct = describeCopyAcrossPath(
			{ id: 'disk', capabilities: {} } as unknown as ExplorerDriver,
			{
				id: 'memory',
				capabilities: {},
				writeFile: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' })
			} as unknown as ExplorerDriver,
			{ source: 'This computer', dest: 'In memory' }
		);
		assert.equal(direct.kind, 'direct');
		const blocked = describeCopyAcrossPath(
			{ id: 'disk', capabilities: {} } as unknown as ExplorerDriver,
			{ id: 'peer-fs', capabilities: {} } as unknown as ExplorerDriver,
			{ source: 'This computer', dest: 'Their disk' }
		);
		assert.equal(blocked.kind, 'blocked');
		assert.equal(
			await copyAcross({
				sourceDriver: b2,
				destDriver: rc,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: null
			}),
			1
		);
		assert.deepEqual(uploaded, ['clip.wav']);
		const copies = listTransfers().filter((t) => t.direction === 'copying');
		assert.equal(copies.some((t) => t.id.endsWith(':remote') && t.done), true);
		assert.equal(copies.some((t) => t.id.endsWith(':wire') && t.done), true);
	});

	it('allows disk → b2 file copy and monitor dest when upload is present', async () => {
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
			capabilities: { supportsUpload: true },
			async upload(_parent: string | null, f: File) {
				return { id: f.name, parentId: null, name: f.name, kind: 'file' };
			}
		} as unknown as ExplorerDriver;
		const peerRo = {
			id: 'peer-fs',
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
		assert.equal(
			await copyAcross({
				sourceDriver: disk,
				destDriver: mon,
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
					destDriver: peerRo,
					selectedIds: [file.id],
					sourceEntries: [file],
					destParentId: null
				}),
			(e: unknown) => e instanceof CopyAcrossError && e.code === 'COPY_ACROSS_DEST_READONLY'
		);
	});

	it('folder copies onto B2 (mkdir + upload)', async () => {
		resetTransferRegistryForTests();
		const folder: ExplorerEntry = {
			id: 'dir',
			parentId: null,
			name: 'dir',
			kind: 'folder'
		};
		const child: ExplorerEntry = {
			id: 'f.txt',
			parentId: 'dir',
			name: 'f.txt',
			kind: 'file',
			size: 4
		};
		const uploaded: string[] = [];
		const disk = {
			id: 'disk',
			capabilities: { supportsMkdir: true, supportsDownload: true },
			async list({ parentId }: { parentId: string | null }) {
				return { entries: parentId === 'dir' ? [child] : [], truncated: false };
			},
			async download() {
				return new Blob(['data']);
			}
		} as unknown as ExplorerDriver;
		const b2 = {
			id: 'b2',
			capabilities: { supportsMkdir: true, supportsUpload: true },
			async mkdir() {
				return { id: 'dir/', parentId: null, name: 'dir', kind: 'folder' as const };
			},
			async upload(_parent: string | null, file: File) {
				uploaded.push(file.name);
				return { id: file.name, parentId: _parent, name: file.name, kind: 'file' as const };
			}
		} as unknown as ExplorerDriver;
		const n = await copyAcross({
			sourceDriver: disk,
			destDriver: b2,
			selectedIds: [folder.id],
			sourceEntries: [folder],
			destParentId: null
		});
		assert.equal(n, 2);
		assert.deepEqual(uploaded, ['f.txt']);
		const copiedFile = listTransfers().find((t) => t.name === 'f.txt' && t.direction === 'copying');
		assert.equal(copiedFile?.destParentId, 'dir/');
		assert.equal(copiedFile?.entryKind, 'file');
	});

	it('B2 folder copies into local browser VFS (mkdir + file download)', async () => {
		resetTransferRegistryForTests();
		const folder: ExplorerEntry = {
			id: 'photos/',
			parentId: null,
			name: 'photos',
			kind: 'folder'
		};
		const child: ExplorerEntry = {
			id: 'photos/a.txt',
			parentId: 'photos/',
			name: 'a.txt',
			kind: 'file',
			size: 5
		};
		const wrote: string[] = [];
		const b2 = {
			id: 'b2',
			capabilities: { supportsMkdir: true, supportsUpload: true, supportsDownload: true },
			async list({ parentId }: { parentId: string | null }) {
				return {
					entries: parentId === 'photos/' ? [child] : [],
					truncated: false
				};
			},
			async download() {
				return new Blob(['hello']);
			}
		} as unknown as ExplorerDriver;
		const local = {
			id: 'local',
			capabilities: { supportsMkdir: true, supportsUpload: true },
			async mkdir(_parent: string | null, name: string) {
				return { id: `local-${name}`, parentId: _parent, name, kind: 'folder' as const };
			},
			async writeFile(_parent: string | null, file: File) {
				wrote.push(file.name);
				return { id: file.name, parentId: _parent, name: file.name, kind: 'file' as const };
			}
		} as unknown as ExplorerDriver;
		const n = await copyAcross({
			sourceDriver: b2,
			destDriver: local,
			selectedIds: [folder.id],
			sourceEntries: [folder],
			destParentId: null
		});
		assert.equal(n, 2);
		assert.deepEqual(wrote, ['a.txt']);
		const copiedFile = listTransfers().find((t) => t.name === 'a.txt' && t.direction === 'copying');
		assert.equal(copiedFile?.destParentId, 'local-photos');
	});
});

function fileEntry(name: string, size = 8): ExplorerEntry {
	return { id: name, parentId: null, name, kind: 'file', size };
}

describe('classify copy-across routing', () => {
	it('same monitor endpointKey, different connectionId → server; copyFromAbsolute not dest.copy', async () => {
		resetTransferRegistryForTests();
		const file = fileEntry('shot.png');
		const copiedRel: string[] = [];
		const copiedAbs: Array<{ from: string; name: string }> = [];
		const left = {
			id: 'monitor',
			connectionId: 'monitor:p1',
			endpointKey: 'monitor:http://127.0.0.1:8300',
			capabilities: { supportsCopy: true, supportsUpload: true },
			absolutePath: (id: string) => `/home/a/${id}`,
			async copy(id: string) {
				copiedRel.push(id);
			}
		} as unknown as ExplorerDriver;
		const right = {
			id: 'monitor',
			connectionId: 'monitor:p2',
			endpointKey: 'monitor:http://127.0.0.1:8300',
			capabilities: { supportsCopy: true, supportsUpload: true },
			async copy(id: string) {
				copiedRel.push(id);
			},
			async copyFromAbsolute(fromAbs: string, _parent: string | null, sourceName: string) {
				copiedAbs.push({ from: fromAbs, name: sourceName });
			}
		} as unknown as ExplorerDriver;
		assert.equal(classify(left, right).kind, 'server');
		assert.equal(canServerCopy(left, right), true);
		assert.equal(isDualPhaseCopy(left, right), false);
		const path = describeCopyAcrossPath(left, right, { source: 'Monitor · a', dest: 'Monitor · b' });
		assert.equal(path.kind, 'server');
		assert.match(path.summary, /Server copy on monitor/);
		assert.match(path.detail, /absolute/i);
		assert.equal(
			await copyAcross({
				sourceDriver: left,
				destDriver: right,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: 'dest/'
			}),
			1
		);
		assert.deepEqual(copiedAbs, [{ from: '/home/a/shot.png', name: 'shot.png' }]);
		assert.deepEqual(copiedRel, []);
	});

	it('same B2 endpointKey different connectionId → server; dest.copy; no download', async () => {
		resetTransferRegistryForTests();
		const file = fileEntry('a.jpg', 12);
		const copied: string[] = [];
		const left = {
			id: 'b2',
			connectionId: 'b2:acct-a',
			endpointKey: 'b2:key::bucket',
			capabilities: { supportsUpload: true, supportsCopy: true },
			async download() {
				throw new Error('must not download');
			}
		} as unknown as ExplorerDriver;
		const right = {
			id: 'b2',
			connectionId: 'b2:acct-b',
			endpointKey: 'b2:key::bucket',
			capabilities: { supportsUpload: true, supportsCopy: true },
			async copy(id: string) {
				copied.push(id);
			},
			async download() {
				throw new Error('must not download');
			}
		} as unknown as ExplorerDriver;
		assert.equal(classify(left, right).kind, 'server');
		assert.equal(
			await copyAcross({
				sourceDriver: left,
				destDriver: right,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: 'archive/'
			}),
			1
		);
		assert.deepEqual(copied, ['a.jpg']);
	});

	it('same endpoint, different connectionId (not B2/monitor) → dual-phase NOT server', () => {
		const left = {
			id: 'peer-fs',
			connectionId: 'peer-fs:p1',
			endpointKey: 'peer-fs:drive::/',
			capabilities: { supportsCopy: true, supportsUpload: true },
			copy: async () => {}
		} as unknown as ExplorerDriver;
		const right = {
			id: 'peer-fs',
			connectionId: 'peer-fs:p2',
			endpointKey: 'peer-fs:drive::/',
			capabilities: { supportsCopy: true, supportsUpload: true },
			copy: async () => {},
			upload: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' })
		} as unknown as ExplorerDriver;
		assert.equal(classify(left, right).kind, 'dual-phase');
		assert.equal(canServerCopy(left, right), false);
		assert.equal(isDualPhaseCopy(left, right), true);
	});

	it('B2→monitor delegated; monitor→B2 delegated', async () => {
		resetTransferRegistryForTests();
		const file = fileEntry('pic.png', 4);
		const pulled: string[] = [];
		const pushed: string[] = [];
		const minted: Array<Record<string, unknown>> = [];
		const b2 = {
			id: 'b2',
			connectionId: 'b2:a',
			endpointKey: 'b2:key::shots',
			capabilities: { supportsUpload: true, supportsCopy: true },
			async mintDownloadUrl(id: string) {
				const out = { url: `https://f000.example/${id}`, filename: 'pic.png', expiresAt: Date.now() + 300_000 };
				minted.push(out as unknown as Record<string, unknown>);
				return out;
			},
			async mintUploadUrl(_parent: string | null, fileName: string) {
				const out = {
					uploadUrl: 'https://pod.example/upload',
					authorizationToken: 'tok',
					destFileName: fileName
				};
				minted.push(out);
				return out;
			},
			async download() {
				throw new Error('must not download for delegated');
			},
			async copy() {
				throw new Error('must not server-copy distinct backends');
			},
			async upload() {
				throw new Error('must not upload for delegated pull');
			}
		} as unknown as ExplorerDriver;
		const mon = {
			id: 'monitor',
			connectionId: 'monitor:p1',
			endpointKey: 'monitor:http://127.0.0.1:8300',
			capabilities: { supportsUpload: true, supportsCopy: true },
			async pullFromUrl(url: string, _parent: string | null, name: string) {
				pulled.push(`${url}::${name}`);
			},
			async pushToUpload(id: string) {
				pushed.push(id);
			},
			async upload() {
				throw new Error('must not upload for delegated');
			}
		} as unknown as ExplorerDriver;
		assert.equal(classify(b2, mon).kind, 'delegated');
		assert.equal(isDualPhaseCopy(b2, mon), false);
		const b2toMon = describeCopyAcrossPath(b2, mon, { source: 'B2 · shots', dest: 'Monitor · home' });
		assert.equal(b2toMon.kind, 'delegated');
		assert.match(b2toMon.summary, /Delegated:/);
		assert.match(b2toMon.detail, /keys stay on their monitor/i);
		assert.match(b2toMon.detail, /No confirm/);
		assert.equal(
			await copyAcross({
				sourceDriver: b2,
				destDriver: mon,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: null
			}),
			1
		);
		assert.equal(pulled.length, 1);
		assert.equal(classify(mon, b2).kind, 'delegated');
		const monToB2 = describeCopyAcrossPath(mon, b2, { source: 'Monitor · home', dest: 'B2 · shots' });
		assert.match(monToB2.summary, /Delegated:/);
		assert.equal(
			await copyAcross({
				sourceDriver: mon,
				destDriver: b2,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: null
			}),
			1
		);
		assert.deepEqual(pushed, ['pic.png']);
		for (const m of minted) {
			assert.equal('applicationKey' in m, false);
			assert.equal('applicationKeyId' in m, false);
		}
		const copies = listTransfers().filter((t) => t.direction === 'copying');
		assert.equal(copies.some((t) => t.hop === 'delegated'), true);
		assert.ok(copies.some((t) => t.id.endsWith(':remote')));
		assert.ok(copies.some((t) => t.id.endsWith(':wire')));
	});

	it('monitor → B2 push splits hash vs upload into stacked legs', async () => {
		resetTransferRegistryForTests();
		const file = fileEntry('clip.wav', 100);
		const b2 = {
			id: 'b2',
			connectionId: 'b2:a',
			endpointKey: 'b2:key::shots',
			capabilities: { supportsUpload: true },
			async mintUploadUrl() {
				return {
					uploadUrl: 'https://pod.example/u',
					authorizationToken: 'tok',
					destFileName: 'clip.wav'
				};
			},
			async upload() {
				throw new Error('must not browser-upload for delegated push');
			}
		} as unknown as ExplorerDriver;
		const mon = {
			id: 'monitor',
			connectionId: 'monitor:p1',
			endpointKey: 'monitor:http://127.0.0.1:8300',
			capabilities: { supportsUpload: true },
			async pushToUpload(_id: string, _up: unknown, opts?: { onEvent?: (ev: { transferred: number; size?: number; done?: boolean; phase?: string }) => void }) {
				opts?.onEvent?.({ transferred: 40, size: 100, phase: 'hash' });
				opts?.onEvent?.({ transferred: 100, size: 100, phase: 'hash' });
				opts?.onEvent?.({ transferred: 0, size: 100, phase: 'upload' });
				opts?.onEvent?.({ transferred: 55, size: 100, phase: 'upload' });
				opts?.onEvent?.({ transferred: 100, size: 100, phase: 'upload', done: true });
			}
		} as unknown as ExplorerDriver;
		await copyAcross({
			sourceDriver: mon,
			destDriver: b2,
			selectedIds: [file.id],
			sourceEntries: [file],
			destParentId: null
		});
		const copies = listTransfers().filter((t) => t.direction === 'copying');
		const remote = copies.find((t) => t.id.endsWith(':remote'));
		const wire = copies.find((t) => t.id.endsWith(':wire'));
		assert.ok(remote);
		assert.ok(wire);
		assert.equal(remote!.done, true);
		assert.equal(remote!.transferred, 100);
		assert.equal(wire!.done, true);
		assert.equal(wire!.transferred, 100);
	});

	it('two monitors different ek → webrtc', () => {
		const a = {
			id: 'monitor',
			connectionId: 'monitor:p1',
			endpointKey: 'monitor:http://127.0.0.1:8300',
			capabilities: { supportsUpload: true },
			upload: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' })
		} as unknown as ExplorerDriver;
		const b = {
			id: 'monitor',
			connectionId: 'monitor:p2',
			endpointKey: 'monitor:http://10.0.0.2:8300',
			capabilities: { supportsUpload: true },
			upload: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' })
		} as unknown as ExplorerDriver;
		assert.equal(classify(a, b).kind, 'webrtc');
		assert.equal(isDualPhaseCopy(a, b), false);
		const path = describeCopyAcrossPath(a, b, { source: 'Monitor · home', dest: 'Monitor · office' });
		assert.equal(path.kind, 'webrtc');
		assert.match(path.summary, /WebRTC between monitors/);
	});

	it('two monitors different endpointKey: copyAcross ferries webrtc', async () => {
		resetTransferRegistryForTests();
		const file = fileEntry('note.txt', 200 * 1024 * 1024);
		let confirmCalls = 0;
		const srcCalls: string[] = [];
		const dstCalls: string[] = [];
		const destWritten: string[] = [];

		function fakeTransport(label: 'src' | 'dst', calls: string[]) {
			return {
				baseUrl: label === 'src' ? 'http://127.0.0.1:8300' : 'http://10.0.0.2:8300',
				async webrtcCreateJob(body: { role: string; from?: string; to?: string; size?: number }) {
					calls.push(`createJob:${body.role}:${body.from ?? ''}:${body.to ?? ''}`);
					return { jobId: `${label}-job`, token: `${label}-tok` };
				},
				async webrtcCreateOffer() {
					calls.push('createOffer');
					return { sdp: 'offer-sdp' };
				},
				async webrtcGetOffer() {
					calls.push('getOffer');
					return { sdp: 'offer-sdp' };
				},
				async webrtcPostAnswer(jobId: string, _token: string, sdp: string) {
					calls.push(`postAnswer:${jobId}:${sdp}`);
					return { sdp: 'answer-sdp' };
				},
				async webrtcProgress(
					_jobId: string,
					_token: string,
					opts?: {
						onEvent?: (ev: {
							transferred: number;
							size?: number;
							ice?: 'checking' | 'connected' | 'failed';
							icePath?: 'host' | 'stun';
							done?: boolean;
						}) => void;
					}
				) {
					calls.push('progress');
					if (label === 'dst') {
						opts?.onEvent?.({
							transferred: 8,
							size: 8,
							ice: 'connected',
							icePath: 'host',
							done: true
						});
					}
				},
				async webrtcAbort() {
					calls.push('abort');
				},
				async unlink() {
					calls.push('unlink');
				}
			};
		}

		const srcClient = fakeTransport('src', srcCalls);
		const dstClient = fakeTransport('dst', dstCalls);
		const left = {
			id: 'monitor',
			connectionId: 'monitor:p1',
			endpointKey: 'monitor:http://127.0.0.1:8300',
			capabilities: { supportsUpload: true },
			uniqueName: async (_p: string | null, base: string) => base,
			absolutePath: (id: string) => `/home/a/${id}`,
			writeExactName: async () => {
				throw new Error('source must not writeExactName on webrtc success');
			},
			download: async () => new Blob(['xxxxxxxx']),
			upload: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' as const }),
			monitorClient: srcClient
		} as unknown as ExplorerDriver;
		const right = {
			id: 'monitor',
			connectionId: 'monitor:p2',
			endpointKey: 'monitor:http://10.0.0.2:8300',
			capabilities: { supportsUpload: true },
			uniqueName: async (_p: string | null, base: string) => base,
			absolutePath: (id: string) => `/home/b/${id}`,
			writeExactName: async (_p: string | null, _f: File, exactName: string) => {
				destWritten.push(exactName);
				return { id: exactName, parentId: null, name: exactName, kind: 'file' };
			},
			download: async () => new Blob(['xxxxxxxx']),
			upload: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' as const }),
			monitorClient: dstClient
		} as unknown as ExplorerDriver;

		assert.equal(classify(left, right).kind, 'webrtc');
		assert.equal(
			await copyAcross({
				sourceDriver: left,
				destDriver: right,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: null,
				confirmDualPhase: async () => {
					confirmCalls += 1;
					return true;
				}
			}),
			1
		);
		assert.equal(confirmCalls, 0);
		assert.ok(srcCalls.some((c) => c.startsWith('createJob:offerer:/home/a/note.txt:')));
		assert.ok(dstCalls.some((c) => c === 'createJob:answerer::/home/b/note.txt'));
		assert.ok(srcCalls.includes('createOffer') || srcCalls.includes('getOffer'));
		assert.ok(dstCalls.includes('progress'));
		assert.deepEqual(destWritten, []);
		const copies = listTransfers().filter((t) => t.direction === 'copying');
		assert.equal(copies.some((t) => t.hop === 'webrtc' && t.done), true);
		assert.equal(copies.some((t) => t.hop === 'dual-phase'), false);
	});

	it('distinct B2 connections → delegated through their monitors', async () => {
		const a = {
			id: 'b2',
			connectionId: 'b2:a',
			endpointKey: 'b2:key::bucket-a',
			capabilities: { supportsUpload: true, supportsCopy: true },
			copy: async () => {}
		} as unknown as ExplorerDriver;
		const b = {
			id: 'b2',
			connectionId: 'b2:b',
			endpointKey: 'b2:key::bucket-b',
			capabilities: { supportsUpload: true, supportsCopy: true },
			copy: async () => {}
		} as unknown as ExplorerDriver;
		assert.equal(classify(a, b).kind, 'delegated');
		assert.equal(canServerCopy(a, b), false);

		// Executed as: source monitor mints, dest monitor pulls. No bytes here.
		resetTransferRegistryForTests();
		const pulled: Array<{ url: string; name: string }> = [];
		const src = {
			...a,
			mintDownloadUrl: async (id: string) => ({ url: `https://f000.backblazeb2.com/file/a/${id}?Authorization=x`, filename: id })
		} as unknown as ExplorerDriver;
		const dst = {
			...b,
			pullFromUrl: async (url: string, _p: string | null, name: string) => {
				pulled.push({ url, name });
			}
		} as unknown as ExplorerDriver;
		const file = fileEntry('pic.png', 4);
		assert.equal(
			await copyAcross({
				sourceDriver: src,
				destDriver: dst,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: null
			}),
			1
		);
		assert.deepEqual(pulled, [
			{ url: 'https://f000.backblazeb2.com/file/a/pic.png?Authorization=x', name: 'pic.png' }
		]);
		const path = describeCopyAcrossPath(src, dst, { source: 'B2 · a', dest: 'B2 · b' });
		assert.match(path.detail, /pulls it into its bucket/);
	});

	it('two disk drivers with dest.copy → canServerCopy false, kind direct', () => {
		const left = {
			id: 'disk',
			capabilities: { supportsCopy: true },
			copy: async () => {}
		} as unknown as ExplorerDriver;
		const right = {
			id: 'disk',
			capabilities: { supportsCopy: true, supportsUpload: true },
			copy: async () => {},
			writeFile: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' })
		} as unknown as ExplorerDriver;
		assert.equal(classify(left, right).kind, 'direct');
		assert.equal(canServerCopy(left, right), false);
	});

	it('same object local + copy → server; two local drivers no cid → direct', () => {
		const local = {
			id: 'local',
			capabilities: { supportsCopy: true },
			copy: async () => {}
		} as unknown as ExplorerDriver;
		assert.equal(classify(local, local).kind, 'server');
		assert.equal(canServerCopy(local, local), true);
		const other = {
			id: 'local',
			capabilities: { supportsCopy: true },
			copy: async () => {},
			writeFile: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' })
		} as unknown as ExplorerDriver;
		assert.equal(classify(local, other).kind, 'direct');
		assert.equal(canServerCopy(local, other), false);
	});

	it('isDualPhaseCopy only when dual-phase', () => {
		const b2 = {
			id: 'b2',
			connectionId: 'b2:a',
			endpointKey: 'b2:k::b',
			capabilities: {},
			copy: async () => {}
		} as unknown as ExplorerDriver;
		const mon = {
			id: 'monitor',
			connectionId: 'monitor:p',
			endpointKey: 'monitor:http://127.0.0.1:8300',
			capabilities: { supportsUpload: true },
			upload: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' })
		} as unknown as ExplorerDriver;
		const rc = {
			id: 'peer-fs',
			connectionId: 'peer-fs:x',
			endpointKey: 'peer-fs:fs::/',
			capabilities: { supportsUpload: true },
			upload: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' })
		} as unknown as ExplorerDriver;
		assert.equal(isDualPhaseCopy(b2, mon), false);
		assert.equal(isDualPhaseCopy(b2, rc), true);
		assert.equal(isDualPhaseCopy(b2, b2), false);
	});

	it('empty endpointKey never matches as server/webrtc', () => {
		const a = {
			id: 'monitor',
			connectionId: 'monitor:p1',
			endpointKey: '',
			capabilities: { supportsUpload: true },
			upload: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' })
		} as unknown as ExplorerDriver;
		const b = {
			id: 'monitor',
			connectionId: 'monitor:p2',
			endpointKey: '',
			capabilities: { supportsUpload: true },
			upload: async () => ({ id: 'x', parentId: null, name: 'x', kind: 'file' })
		} as unknown as ExplorerDriver;
		assert.equal(classify(a, b).kind, 'dual-phase');
	});

	it('server B2 copy size > EXPLORER_DOWNLOAD_MAX_BYTES does NOT throw; dual-phase still throws', async () => {
		resetTransferRegistryForTests();
		const huge = fileEntry('huge.bin', EXPLORER_DOWNLOAD_MAX_BYTES + 1);
		const copied: string[] = [];
		const b2a = {
			id: 'b2',
			connectionId: 'b2:a',
			endpointKey: 'b2:key::bucket',
			capabilities: { supportsCopy: true, supportsUpload: true }
		} as unknown as ExplorerDriver;
		const b2b = {
			id: 'b2',
			connectionId: 'b2:a',
			endpointKey: 'b2:key::bucket',
			capabilities: { supportsCopy: true, supportsUpload: true },
			async copy(id: string) {
				copied.push(id);
			}
		} as unknown as ExplorerDriver;
		assert.equal(
			await copyAcross({
				sourceDriver: b2a,
				destDriver: b2b,
				selectedIds: [huge.id],
				sourceEntries: [huge],
				destParentId: null
			}),
			1
		);
		assert.deepEqual(copied, ['huge.bin']);

		const rc = {
			id: 'peer-fs',
			connectionId: 'peer-fs:z',
			capabilities: { supportsUpload: true },
			async upload() {
				return { id: 'x', parentId: null, name: 'x', kind: 'file' };
			}
		} as unknown as ExplorerDriver;
		await assert.rejects(
			() =>
				copyAcross({
					sourceDriver: b2a,
					destDriver: rc,
					selectedIds: [huge.id],
					sourceEntries: [huge],
					destParentId: null
				}),
			(e: unknown) => e instanceof CopyAcrossError && e.code === 'EXPLORER_TOO_LARGE'
		);
	});

	it('same-monitor B2 and disk copy on the host, not through a minted URL', async () => {
		resetTransferRegistryForTests();
		const file = fileEntry('clip.mov', 200 * 1024 * 1024);
		const host = 'monitor:http://127.0.0.1:8300';
		const sent: string[] = [];
		const accepted: string[] = [];
		const b2 = {
			id: 'b2',
			connectionId: 'b2:row',
			endpointKey: `b2:${host}::photos`,
			hostConnectionId: 'photos',
			capabilities: { supportsUpload: true },
			async sendToHostPath(key: string, abs: string) {
				sent.push(`${key}→${abs}`);
			},
			async acceptHostFile(abs: string, _parent: string | null, name: string) {
				accepted.push(`${abs}→${name}`);
			},
			async mintDownloadUrl() {
				throw new Error('must not mint when both sides are this monitor');
			},
			async mintUploadUrl() {
				throw new Error('must not mint when both sides are this monitor');
			},
			async upload() {
				throw new Error('must not browser-upload');
			}
		} as unknown as ExplorerDriver;
		const mon = {
			id: 'monitor',
			connectionId: 'monitor:p',
			endpointKey: host,
			capabilities: { supportsUpload: true },
			absolutePath(id: string) {
				return `/data/${id}`;
			},
			async uniqueName(_parent: string | null, base: string) {
				return base;
			},
			async upload() {
				throw new Error('must not browser-upload');
			},
			async pullFromUrl() {
				throw new Error('must not pull through a URL on the same monitor');
			},
			async pushToUpload() {
				throw new Error('must not single-shot push on the same monitor');
			}
		} as unknown as ExplorerDriver;
		assert.equal(
			await copyAcross({
				sourceDriver: b2,
				destDriver: mon,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: null
			}),
			1
		);
		assert.deepEqual(sent, ['clip.mov→/data/clip.mov']);
		assert.equal(
			await copyAcross({
				sourceDriver: mon,
				destDriver: b2,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: 'vids/'
			}),
			1
		);
		assert.deepEqual(accepted, ['/data/clip.mov→clip.mov']);
	});

	it('cross-monitor file over 100 MiB and under 5 GiB is one push', async () => {
		resetTransferRegistryForTests();
		const file = fileEntry('clip.mov', 200 * 1024 * 1024);
		let largeStarts = 0;
		const pushed: Array<{ partNumber?: number; offset?: number }> = [];
		const b2 = {
			id: 'b2',
			connectionId: 'b2:other',
			endpointKey: 'b2:monitor:http://10.0.0.2:8300::bucket',
			capabilities: { supportsUpload: true },
			async startLargeUpload() {
				largeStarts += 1;
				throw new Error('a single b2_upload_file still fits');
			},
			async mintUploadUrl() {
				return {
					uploadUrl: 'https://pod.example/u',
					authorizationToken: 'tok',
					destFileName: 'clip.mov'
				};
			},
			async upload() {
				throw new Error('must not browser-upload');
			},
			async download() {
				throw new Error('must not download into the tab');
			}
		} as unknown as ExplorerDriver;
		const mon = {
			id: 'monitor',
			connectionId: 'monitor:src',
			endpointKey: 'monitor:http://10.0.0.1:8300',
			capabilities: { supportsUpload: true },
			async pushToUpload(
				_id: string,
				upload: { partNumber?: number; offset?: number }
			) {
				pushed.push({ partNumber: upload.partNumber, offset: upload.offset });
			},
			async download() {
				throw new Error('must not download into the tab');
			}
		} as unknown as ExplorerDriver;
		assert.equal(
			await copyAcross({
				sourceDriver: mon,
				destDriver: b2,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: null
			}),
			1
		);
		assert.deepEqual(pushed, [{ partNumber: undefined, offset: undefined }]);
		assert.equal(largeStarts, 0);
	});

	it('cross-monitor B2 download over 100 MiB streams on the destination monitor', async () => {
		resetTransferRegistryForTests();
		const file = fileEntry('clip.mov', 200 * 1024 * 1024);
		const pulled: string[] = [];
		const b2 = {
			id: 'b2',
			connectionId: 'b2:src',
			endpointKey: 'b2:monitor:http://10.0.0.1:8300::bucket',
			capabilities: { supportsUpload: true },
			async mintDownloadUrl() {
				return { url: 'https://f000.example/clip.mov', filename: 'clip.mov' };
			},
			async download() {
				throw new Error('must not download into the tab');
			}
		} as unknown as ExplorerDriver;
		const mon = {
			id: 'monitor',
			connectionId: 'monitor:dst',
			endpointKey: 'monitor:http://10.0.0.2:8300',
			capabilities: { supportsUpload: true },
			async pullFromUrl(url: string) {
				pulled.push(url);
			},
			async upload() {
				throw new Error('must not browser-upload');
			},
			async download() {
				throw new Error('must not download into the tab');
			}
		} as unknown as ExplorerDriver;
		assert.equal(
			await copyAcross({
				sourceDriver: b2,
				destDriver: mon,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: null
			}),
			1
		);
		assert.deepEqual(pulled, ['https://f000.example/clip.mov']);
	});

	it('cross-monitor file over 5 GiB uploads as large-file parts', async () => {
		resetTransferRegistryForTests();
		const size = 5 * 1024 * 1024 * 1024 + 10;
		const partSize = 5 * 1024 * 1024 * 1024;
		const file = fileEntry('huge.bin', size);
		const parts: Array<{ offset?: number; length?: number; partNumber?: number }> = [];
		const finished: string[][] = [];
		let cancelled = 0;
		const b2 = {
			id: 'b2',
			connectionId: 'b2:other',
			endpointKey: 'b2:monitor:http://10.0.0.2:8300::bucket',
			capabilities: { supportsUpload: true },
			async startLargeUpload() {
				return { fileId: 'large-1', destFileName: 'huge.bin', partSize, contentType: 'application/octet-stream' };
			},
			async mintPartUrl() {
				return { uploadUrl: 'https://pod.example/part', authorizationToken: 'tok' };
			},
			async finishLargeUpload(_id: string, shas: string[]) {
				finished.push(shas);
			},
			async cancelLargeUpload() {
				cancelled += 1;
			},
			async mintUploadUrl() {
				throw new Error('must not use a single upload URL over 5 GiB');
			},
			async upload() {
				throw new Error('must not browser-upload');
			}
		} as unknown as ExplorerDriver;
		const mon = {
			id: 'monitor',
			connectionId: 'monitor:src',
			endpointKey: 'monitor:http://10.0.0.1:8300',
			capabilities: { supportsUpload: true },
			async pushToUpload(
				_id: string,
				upload: { offset?: number; length?: number; partNumber?: number },
				opts?: { onEvent?: (ev: { sha1?: string; transferred?: number; phase?: string; done?: boolean }) => void }
			) {
				parts.push({ offset: upload.offset, length: upload.length, partNumber: upload.partNumber });
				opts?.onEvent?.({
					phase: 'upload',
					transferred: upload.length,
					done: true,
					sha1: `sha-${upload.partNumber}`
				});
			}
		} as unknown as ExplorerDriver;
		assert.equal(
			await copyAcross({
				sourceDriver: mon,
				destDriver: b2,
				selectedIds: [file.id],
				sourceEntries: [file],
				destParentId: null
			}),
			1
		);
		assert.equal(parts.length, 2);
		assert.equal(parts[0]?.partNumber, 1);
		assert.equal(parts[0]?.offset, 0);
		assert.equal(parts[0]?.length, partSize);
		assert.equal(parts[1]?.offset, partSize);
		assert.equal(parts[1]?.partNumber, 2);
		assert.equal(parts[1]?.length, size - partSize);
		assert.deepEqual(finished, [parts.map((p) => `sha-${p.partNumber}`)]);
		assert.equal(cancelled, 0);
	});

	it('monitor and B2 files stream into browser storage past the Blob cap', async () => {
		const doneWith: unknown[] = [];
		resetFileOpsForTest(async (input: StartOp): Promise<OpHandle> => ({
			id: input.id!,
			signal: new AbortController().signal,
			progress() {},
			done: async (result) => {
				doneWith.push(result);
			},
			fail: async () => {},
			cancelled: async () => {},
			onCancelRequest() {
				return () => {};
			}
		}));
		const huge = fileEntry('big.bin', EXPLORER_DOWNLOAD_MAX_BYTES + 1);
		huge.contentType = 'video/mp4';
		const payload = ['hel', 'lo'];
		let downloads = 0;
		const written: Array<{ name: string; bytes: string; contentType?: string }> = [];
		const source = {
			id: 'monitor',
			connectionId: 'monitor:p',
			endpointKey: 'monitor:http://127.0.0.1:8300',
			capabilities: { supportsUpload: true, supportsDownload: true },
			async download() {
				downloads += 1;
				throw new Error('must not blob');
			},
			async openDownloadStream() {
				return {
					stream: bytesStream(payload),
					contentType: 'application/octet-stream',
					size: 5
				};
			}
		} as unknown as ExplorerDriver;
		const local = browserFilesDest(written);
		assert.equal(classify(source, local).kind, 'direct');
		assert.equal(
			await copyAcross({
				sourceDriver: source,
				destDriver: local,
				selectedIds: [huge.id],
				sourceEntries: [huge],
				destParentId: 'inbox'
			}),
			1
		);
		assert.equal(downloads, 0);
		assert.deepEqual(written, [{ name: 'big.bin', bytes: 'hello', contentType: 'video/mp4' }]);
		assert.deepEqual(doneWith, [{ kind: 'vfs-file', fileId: 'vfs-big.bin', name: 'big.bin' }]);
		const finished = listTransfers().find((t) => t.name === 'big.bin' && t.done);
		assert.equal(finished?.status, 'done');
		assert.equal(finished?.hop, 'direct');
		assert.equal(finished?.transferred, 5);

		doneWith.length = 0;
		written.length = 0;
		const b2File = fileEntry('clip.mov', EXPLORER_DOWNLOAD_MAX_BYTES + 1);
		const b2 = {
			id: 'b2',
			connectionId: 'b2:row',
			endpointKey: 'b2:monitor:http://127.0.0.1:8300::photos',
			capabilities: { supportsUpload: true, supportsDownload: true },
			async download() {
				downloads += 1;
				throw new Error('must not blob');
			},
			async openDownloadStream() {
				return { stream: bytesStream(['xy']), contentType: 'video/quicktime', size: 2 };
			}
		} as unknown as ExplorerDriver;
		assert.equal(
			await copyAcross({
				sourceDriver: b2,
				destDriver: local,
				selectedIds: [b2File.id],
				sourceEntries: [b2File],
				destParentId: null
			}),
			1
		);
		assert.equal(downloads, 0);
		assert.deepEqual(written, [{ name: 'clip.mov', bytes: 'xy', contentType: 'video/quicktime' }]);
		assert.deepEqual(doneWith, [{ kind: 'vfs-file', fileId: 'vfs-clip.mov', name: 'clip.mov' }]);
	});

	it('a file under the cap still streams when the destination can take a stream', async () => {
		resetTransferRegistryForTests();
		const small = fileEntry('note.txt', 4);
		let downloads = 0;
		const written: Array<{ name: string; bytes: string; contentType?: string }> = [];
		const source = {
			id: 'monitor',
			capabilities: { supportsDownload: true },
			async download() {
				downloads += 1;
				return new Blob(['nope']);
			},
			async openDownloadStream() {
				return { stream: bytesStream(['note']), contentType: 'text/plain' };
			}
		} as unknown as ExplorerDriver;
		assert.equal(
			await copyAcross({
				sourceDriver: source,
				destDriver: browserFilesDest(written),
				selectedIds: [small.id],
				sourceEntries: [small],
				destParentId: null
			}),
			1
		);
		assert.equal(downloads, 0);
		assert.deepEqual(written, [{ name: 'note.txt', bytes: 'note', contentType: 'text/plain' }]);
	});

	it('a monitor folder streams each file instead of bulk-blobbing them', async () => {
		resetTransferRegistryForTests();
		const folder = { id: 'pics/', parentId: null, name: 'pics', kind: 'folder' as const };
		const child = fileEntry('big.bin', EXPLORER_DOWNLOAD_MAX_BYTES + 1);
		child.parentId = 'pics/';
		let downloads = 0;
		let bulks = 0;
		const written: Array<{ name: string; bytes: string; contentType?: string }> = [];
		const source = {
			id: 'monitor',
			connectionId: 'monitor:p',
			endpointKey: 'monitor:http://127.0.0.1:8300',
			capabilities: { supportsDownload: true },
			async list() {
				return { entries: [child], truncated: false };
			},
			async download() {
				downloads += 1;
				throw new Error('must not blob');
			},
			async openDownloadStream(id: string) {
				assert.equal(id, 'big.bin');
				return { stream: bytesStream(['ab', 'c']), contentType: 'application/octet-stream' };
			}
		} as unknown as ExplorerDriver;
		const local = browserFilesDest(written);
		local.writeFiles = async () => {
			bulks += 1;
			return [];
		};
		assert.equal(
			await copyAcross({
				sourceDriver: source,
				destDriver: local,
				selectedIds: [folder.id],
				sourceEntries: [folder],
				destParentId: null
			}),
			2
		);
		assert.equal(downloads, 0);
		assert.equal(bulks, 0);
		assert.deepEqual(written, [{ name: 'big.bin', bytes: 'abc', contentType: 'application/octet-stream' }]);
	});

	it('without a stream on both sides a huge file still hits the Blob cap', async () => {
		resetTransferRegistryForTests();
		const huge = fileEntry('huge.bin', EXPLORER_DOWNLOAD_MAX_BYTES + 1);
		const source = {
			id: 'monitor',
			capabilities: { supportsDownload: true },
			async download() {
				throw new Error('must not download');
			},
			async openDownloadStream() {
				throw new Error('dest cannot stream');
			}
		} as unknown as ExplorerDriver;
		const disk = {
			id: 'disk',
			capabilities: { supportsUpload: true },
			async upload() {
				throw new Error('must not upload');
			}
		} as unknown as ExplorerDriver;
		await assert.rejects(
			() =>
				copyAcross({
					sourceDriver: source,
					destDriver: disk,
					selectedIds: [huge.id],
					sourceEntries: [huge],
					destParentId: null
				}),
			(e: unknown) => e instanceof CopyAcrossError && e.code === 'EXPLORER_TOO_LARGE'
		);

		const plain = {
			id: 'monitor',
			capabilities: { supportsDownload: true },
			async download() {
				throw new Error('must not download');
			}
		} as unknown as ExplorerDriver;
		const local = {
			id: 'local',
			capabilities: { supportsUpload: true },
			async writeFile() {
				throw new Error('must not write');
			}
		} as unknown as ExplorerDriver;
		await assert.rejects(
			() =>
				copyAcross({
					sourceDriver: plain,
					destDriver: local,
					selectedIds: [huge.id],
					sourceEntries: [huge],
					destParentId: null
				}),
			(e: unknown) => e instanceof CopyAcrossError && e.code === 'EXPLORER_TOO_LARGE'
		);
	});

	it('dual-phase stays on the Blob cap even when both sides can stream', async () => {
		resetTransferRegistryForTests();
		const huge = fileEntry('huge.bin', EXPLORER_DOWNLOAD_MAX_BYTES + 1);
		const source = {
			id: 'peer-fs',
			connectionId: 'peer-fs:a',
			endpointKey: 'peer-fs:fs::/',
			capabilities: { supportsUpload: true },
			async openDownloadStream() {
				throw new Error('must not stream a dual-phase copy');
			},
			async download() {
				throw new Error('must not download');
			}
		} as unknown as ExplorerDriver;
		const dest = {
			id: 'peer-fs',
			connectionId: 'peer-fs:b',
			endpointKey: 'peer-fs:fs::other',
			capabilities: { supportsUpload: true },
			async upload() {
				return { id: 'x', parentId: null, name: 'x', kind: 'file' as const };
			},
			async writeFileStream() {
				throw new Error('must not stream');
			}
		} as unknown as ExplorerDriver;
		assert.equal(classify(source, dest).kind, 'dual-phase');
		await assert.rejects(
			() =>
				copyAcross({
					sourceDriver: source,
					destDriver: dest,
					selectedIds: [huge.id],
					sourceEntries: [huge],
					destParentId: null
				}),
			(e: unknown) => e instanceof CopyAcrossError && e.code === 'EXPLORER_TOO_LARGE'
		);
	});
});

function bytesStream(parts: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i >= parts.length) {
				controller.close();
				return;
			}
			controller.enqueue(enc.encode(parts[i]!));
			i += 1;
		}
	});
}

function browserFilesDest(written: Array<{ name: string; bytes: string; contentType?: string }>): ExplorerDriver {
	return {
		id: 'local',
		capabilities: { supportsMkdir: true, supportsUpload: true },
		async mkdir(_parent: string | null, name: string) {
			return { id: `local-${name}`, parentId: _parent, name, kind: 'folder' };
		},
		async writeFile() {
			throw new Error('must not blob-write');
		},
		async writeFileStream(parentId: string | null, name: string, stream: ReadableStream<Uint8Array>, opts?: { contentType?: string }) {
			const bytes = await new Response(stream).text();
			written.push({ name, bytes, contentType: opts?.contentType });
			return { id: `vfs-${name}`, parentId, name, kind: 'file', size: bytes.length };
		}
	} as unknown as ExplorerDriver;
}
