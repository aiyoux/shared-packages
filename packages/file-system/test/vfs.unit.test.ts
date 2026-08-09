import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, VfsError, isActionable, resetSharedVfsForTests } from '../src/index.ts';

describe('VfsService', () => {
	let vfs: ReturnType<typeof createVfs>;

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({ dbName: `test-vfs-${Date.now()}-${Math.random()}`, memoryOpfs: true });
		await vfs.ready();
	});

	it('mkdir + writeFile + list', async () => {
		const folder = await vfs.mkdir(null, 'Sketches');
		const file = await vfs.writeFile({
			parentId: folder.id,
			name: 'demo',
			fileType: 'skch',
			body: { format: 'skch', schemaVersion: 1, name: 'demo', data: { paths: [] } }
		});
		assert.equal(file.name, 'demo.skch');
		assert.equal(file.fileType, 'skch');
		assert.ok(file.generation === 1);
		const listed = await vfs.list({ parentId: folder.id });
		assert.equal(listed.length, 1);
		const json = await vfs.readJson(file.id);
		assert.equal((json as { format: string }).format, 'skch');
	});

	it('name collision auto-suffix', async () => {
		await vfs.writeFile({ parentId: null, name: 'a.skch', fileType: 'skch', body: { n: 1 } });
		const b = await vfs.writeFile({ parentId: null, name: 'a.skch', fileType: 'skch', body: { n: 2 } });
		assert.equal(b.name, 'a (1).skch');
	});

	it('updateFile generation CAS', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 'x.skch', fileType: 'skch', body: { v: 1 } });
		const u1 = await vfs.updateFile(f.id, { v: 2 }, { expectedGeneration: f.generation });
		assert.equal(u1.generation, 2);
		await assert.rejects(
			() => vfs.updateFile(f.id, { v: 3 }, { expectedGeneration: 1 }),
			(e: unknown) => e instanceof VfsError && e.code === 'GENERATION_CONFLICT'
		);
		const forced = await vfs.updateFile(f.id, { v: 4 }, { force: true });
		assert.equal(forced.generation, 3);
		assert.deepEqual(await vfs.readJson(f.id), { v: 4 });
	});

	it('trash restore permanentDelete', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 't.skch', fileType: 'skch', body: { a: 1 } });
		await vfs.trash(f.id);
		const active = await vfs.list({ parentId: null });
		assert.equal(active.length, 0);
		const trash = await vfs.list({ parentId: null, trashOnly: true });
		assert.equal(trash.length, 1);
		await vfs.restore(f.id);
		assert.equal((await vfs.list({ parentId: null })).length, 1);
		await vfs.trash(f.id);
		await vfs.permanentDelete(f.id, { recursive: true });
		assert.equal((await vfs.list({ parentId: null, trashOnly: true })).length, 0);
	});

	it('folder trash subtree', async () => {
		const dir = await vfs.mkdir(null, 'A');
		await vfs.writeFile({ parentId: dir.id, name: 'f.skch', fileType: 'skch', body: {} });
		await vfs.trash(dir.id);
		assert.equal((await vfs.list({ parentId: null })).length, 0);
		const roots = await vfs.list({ parentId: null, trashOnly: true });
		assert.equal(roots.length, 1);
		await vfs.restore(dir.id);
		assert.equal((await vfs.list({ parentId: dir.id })).length, 1);
	});

	it('isActionable grey-out helper', () => {
		assert.equal(isActionable({ kind: 'folder' } as any, ['skch']), true);
		assert.equal(
			isActionable({ kind: 'file', fileType: 'vrec' } as any, ['skch']),
			false
		);
		assert.equal(
			isActionable({ kind: 'file', fileType: 'skch' } as any, ['skch']),
			true
		);
	});

	it('rename move copy', async () => {
		const a = await vfs.mkdir(null, 'A');
		const b = await vfs.mkdir(null, 'B');
		const f = await vfs.writeFile({
			parentId: a.id,
			name: 'c.skch',
			fileType: 'skch',
			body: { x: 1 }
		});
		await vfs.rename(f.id, 'd');
		assert.equal((await vfs.get(f.id))!.name, 'd.skch');
		await vfs.move(f.id, b.id);
		assert.equal((await vfs.get(f.id))!.parentId, b.id);
		const copy = await vfs.copy(f.id, a.id);
		assert.notEqual(copy.id, f.id);
		assert.deepEqual(await vfs.readJson(copy.id), { x: 1 });
	});

	it('drafts not in list', async () => {
		await vfs.putDraft({
			id: 'sketcher:current',
			appId: 'sketcher',
			updatedAt: Date.now(),
			payload: { dirty: true }
		});
		assert.equal((await vfs.list({ parentId: null })).length, 0);
		assert.ok(await vfs.getDraft('sketcher:current'));
	});

	it('gc removes unreferenced after permanent delete', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 'g.skch', fileType: 'skch', body: { z: 9 } });
		await vfs.trash(f.id);
		await vfs.permanentDelete(f.id, { recursive: true });
		const report = await vfs.gc();
		assert.ok(report.orphanBlobRefsRemoved >= 0);
	});

	it('read missing OPFS throws OPFS_IO', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 'm.skch', fileType: 'skch', body: { q: 1 } });
		const node = await vfs.get(f.id);
		const ref = await vfs.db.blobRefs.get(node!.blobId!);
		await vfs.opfs.remove(ref!.opfsPath);
		await assert.rejects(
			() => vfs.readBytes(f.id),
			(e: unknown) => e instanceof VfsError && e.code === 'OPFS_IO'
		);
	});

	it('writeFile preserves multi-ext image names (omit or pass fileType image)', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		// Omit fileType → infer image from .jpg → must NOT become photo.jpg.png
		const jpg = await vfs.writeFile({
			parentId: null,
			name: 'photo.jpg',
			body: bytes,
			contentType: 'image/jpeg'
		});
		assert.equal(jpg.name, 'photo.jpg');
		assert.equal(jpg.fileType, 'image');

		const webp = await vfs.writeFile({
			parentId: null,
			name: 'icon.webp',
			fileType: 'image',
			body: bytes,
			contentType: 'image/webp'
		});
		assert.equal(webp.name, 'icon.webp');
		assert.equal(webp.fileType, 'image');

		// bare name with image type still gets primary .png
		const bare = await vfs.writeFile({
			parentId: null,
			name: 'shot',
			fileType: 'image',
			body: bytes
		});
		assert.equal(bare.name, 'shot.png');
		assert.equal(bare.fileType, 'image');
	});
});
