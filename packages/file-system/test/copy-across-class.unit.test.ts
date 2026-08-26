import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXPLORER_DOWNLOAD_MAX_BYTES, isLocalClass, isRemoteClass } from '../src/ui/explorerDriver.ts';
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
			size: 8
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
			id: 'rclone',
			connectionId: 'rclone:other',
			endpointKey: 'rclone:gdrive::/',
			capabilities: { supportsUpload: true },
			async upload(_parent: string | null, f: File, opts?: { onProgress?: (pct: number) => void }) {
				opts?.onProgress?.(1);
				uploaded.push(f.name);
				return { id: f.name, parentId: null, name: f.name, kind: 'file' };
			}
		} as unknown as ExplorerDriver;
		assert.equal(isDualPhaseCopy(b2, rc), true);
		const path = describeCopyAcrossPath(b2, rc, { source: 'B2 · shots', dest: 'rclone · drive' });
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

	it('rclone same fs different connectionId → dual-phase NOT server', () => {
		const left = {
			id: 'rclone',
			connectionId: 'rclone:p1',
			endpointKey: 'rclone:gdrive::/',
			capabilities: { supportsCopy: true, supportsUpload: true },
			copy: async () => {}
		} as unknown as ExplorerDriver;
		const right = {
			id: 'rclone',
			connectionId: 'rclone:p2',
			endpointKey: 'rclone:gdrive::/',
			capabilities: { supportsCopy: true, supportsUpload: true },
			copy: async () => {}
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
		assert.match(b2toMon.detail, /keys stay in this tab/i);
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
		const file = fileEntry('note.txt', 8);
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

	it('distinct B2 buckets → dual-phase', () => {
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
		assert.equal(classify(a, b).kind, 'dual-phase');
		assert.equal(canServerCopy(a, b), false);
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
			id: 'rclone',
			connectionId: 'rclone:x',
			endpointKey: 'rclone:fs::/',
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
			id: 'rclone',
			connectionId: 'rclone:z',
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
});

