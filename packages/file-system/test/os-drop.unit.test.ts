import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	importOsDropToDriver,
	nodesFromFiles,
	OsDropError,
	snapshotFiles,
	type OsDropNode
} from '../src/ui/osDrop.ts';
import { formatExplorerError } from '../src/ui/explorerError.ts';
import { ExplorerB2Error } from '../src/b2/errors.ts';
import { VfsError } from '../src/types.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

function fileWithPath(name: string, body: string, relativePath: string): File {
	const f = new File([body], name, { type: 'text/plain' });
	Object.defineProperty(f, 'webkitRelativePath', { value: relativePath });
	return f;
}

function mockDriver(opts?: { mkdir?: boolean }): ExplorerDriver & {
	writes: Array<{ parentId: string | null; name: string; text: string }>;
	mkdirs: Array<{ parentId: string | null; name: string }>;
} {
	const writes: Array<{ parentId: string | null; name: string; text: string }> = [];
	const mkdirs: Array<{ parentId: string | null; name: string }> = [];
	let n = 0;
	const drv: ExplorerDriver & {
		writes: typeof writes;
		mkdirs: typeof mkdirs;
	} = {
		id: 'mock',
		capabilities: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: false,
			supportsMove: false,
			supportsCopy: false,
			supportsMkdir: Boolean(opts?.mkdir),
			supportsUpload: true,
			supportsDownload: false,
			supportsSiblingOrder: false,
			supportsDragOut: false
		},
		writes,
		mkdirs,
		async ready() {},
		async list() {
			return { entries: [] };
		},
		async getPath() {
			return [];
		},
		async delete() {},
		async writeFile(parentId, file) {
			writes.push({ parentId, name: file.name, text: await file.text() });
			n += 1;
			return {
				id: `f${n}`,
				parentId,
				name: file.name,
				kind: 'file'
			} as ExplorerEntry;
		}
	};
	if (opts?.mkdir) {
		drv.mkdir = async (parentId, name) => {
			mkdirs.push({ parentId, name });
			n += 1;
			return { id: `d${n}`, parentId, name, kind: 'folder' } as ExplorerEntry;
		};
	}
	return drv;
}

describe('os folder drop', () => {
	it('nodesFromFiles infers folders from webkitRelativePath', () => {
		const nodes = nodesFromFiles([
			fileWithPath('a.txt', 'a', 'Trip/a.txt'),
			fileWithPath('b.txt', 'b', 'Trip/inner/b.txt')
		]);
		assert.deepEqual(
			nodes.filter((n) => n.kind === 'folder').map((n) => n.relativePath),
			['Trip', 'Trip/inner']
		);
		assert.equal(nodes.filter((n) => n.kind === 'file').length, 2);
	});

	it('snapshotFiles copies bytes so the original File can be revoked', async () => {
		const orig = new File(['hello'], 'x.txt', { type: 'text/plain' });
		const nodes = await snapshotFiles([orig]);
		const file = nodes.find((n) => n.kind === 'file')?.file;
		assert.ok(file);
		assert.equal(await file.text(), 'hello');
		assert.notEqual(file, orig);
	});

	it('importOsDropToDriver mkdirs then writes into nested parents', async () => {
		const drv = mockDriver({ mkdir: true });
		const nodes: OsDropNode[] = [
			{ relativePath: 'Trip', kind: 'folder' },
			{ relativePath: 'Trip/inner', kind: 'folder' },
			{
				relativePath: 'Trip/inner/shot.txt',
				kind: 'file',
				file: new File(['snap'], 'shot.txt', { type: 'text/plain' })
			}
		];
		const r = await importOsDropToDriver(drv, null, nodes);
		assert.equal(r.folders, 2);
		assert.equal(r.files, 1);
		assert.deepEqual(drv.mkdirs, [
			{ parentId: null, name: 'Trip' },
			{ parentId: 'd1', name: 'inner' }
		]);
		assert.equal(drv.writes.length, 1);
		assert.equal(drv.writes[0].parentId, 'd2');
		assert.equal(drv.writes[0].name, 'shot.txt');
		assert.equal(drv.writes[0].text, 'snap');
	});

	it('importOsDropToDriver rejects nested drops when mkdir is missing', async () => {
		const drv = mockDriver({ mkdir: false });
		await assert.rejects(
			() =>
				importOsDropToDriver(drv, null, [
					{
						relativePath: 'Trip/a.txt',
						kind: 'file',
						file: new File(['x'], 'a.txt')
					}
				]),
			(e: unknown) => e instanceof OsDropError && /cannot create folders/i.test((e as Error).message)
		);
	});

	it('collectOsDrop keeps webkitRelativePath from FileList', async () => {
		const { collectOsDrop } = await import('../src/ui/osDrop.ts');
		const nested = fileWithPath('notes.txt', 'hi', 'Trip/inner/notes.txt');
		const dt = {
			files: {
				length: 1,
				0: nested,
				item: (i: number) => (i === 0 ? nested : null),
				[Symbol.iterator]: function* () {
					yield nested;
				}
			}
		} as unknown as DataTransfer;
		const nodes = await collectOsDrop(dt);
		assert.deepEqual(
			nodes.map((n) => `${n.kind}:${n.relativePath}`),
			['folder:Trip', 'folder:Trip/inner', 'file:Trip/inner/notes.txt']
		);
		assert.equal(await nodes[2].file!.text(), 'hi');
	});

	it('flat file drop works without mkdir', async () => {
		const drv = mockDriver({ mkdir: false });
		const r = await importOsDropToDriver(drv, 'root', [
			{ relativePath: 'solo.txt', kind: 'file', file: new File(['z'], 'solo.txt') }
		]);
		assert.equal(r.files, 1);
		assert.equal(drv.writes[0].parentId, 'root');
	});
});

describe('formatExplorerError', () => {
	it('does not surface raw B2_ERROR', () => {
		const e = new ExplorerB2Error('B2_ERROR', '');
		const msg = formatExplorerError(e);
		assert.notEqual(msg, 'B2_ERROR');
		assert.notEqual(msg, 'B2 error');
		assert.match(msg, /backblaze|b2/i);
	});

	it('rewrites revoked-directory DOM errors', () => {
		const e = new DOMException(
			'A requested file or directory could not be found at the time an operation was processed.',
			'NotFoundError'
		);
		assert.match(formatExplorerError(e), /dropped folder/i);
	});

	it('uses a sentence for VfsError codes', () => {
		assert.match(formatExplorerError(new VfsError('OPFS_IO')), /browser storage/i);
	});
});
