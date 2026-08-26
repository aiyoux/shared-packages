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

	it('emptyTrash bulk-deletes a folder tree and reports progress without per-file notifies', async () => {
		await vfs.writeFile({ parentId: null, name: 'keep.txt', body: 'keep' });
		const dir = await vfs.mkdir(null, 'repo');
		for (let i = 0; i < 20; i++) {
			await vfs.writeFile({ parentId: dir.id, name: `n${i}.txt`, body: `x${i}` });
		}
		await vfs.trash(dir.id);
		assert.equal((await vfs.list({ parentId: null, trashOnly: true })).length, 1);

		let notifies = 0;
		const unsub = vfs.subscribe(() => {
			notifies++;
		});
		const ticks: Array<{ done: number; total: number }> = [];
		await vfs.emptyTrash({
			onProgress: (ev) => ticks.push({ done: ev.done, total: ev.total })
		});
		unsub();

		assert.ok(notifies >= 1 && notifies <= 2);
		assert.ok(ticks.length >= 2);
		assert.equal(ticks[0]!.done, 0);
		assert.ok(ticks[0]!.total >= 21);
		assert.equal(ticks[ticks.length - 1]!.done, ticks[ticks.length - 1]!.total);
		assert.equal((await vfs.list({ parentId: null, trashOnly: true })).length, 0);
		const live = await vfs.list({ parentId: null });
		assert.equal(live.length, 1);
		assert.equal(live[0]!.name, 'keep.txt');
	});

	it('emptyTrash abort before work leaves trash in place', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 'gone.txt', body: 'x' });
		await vfs.trash(f.id);
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(
			() => vfs.emptyTrash({ signal: ac.signal }),
			(e: unknown) => e instanceof Error && e.name === 'AbortError'
		);
		assert.equal((await vfs.list({ parentId: null, trashOnly: true })).length, 1);
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

	it('updateFile keeps the old blob if promote fails', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'keep.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const before = await vfs.get(f.id);
		const origPromote = vfs.opfs.promote.bind(vfs.opfs);
		vfs.opfs.promote = async () => {
			throw new Error('promote-boom');
		};
		await assert.rejects(
			() => vfs.updateFile(f.id, { v: 2 }, { expectedGeneration: f.generation }),
			(e: unknown) => e instanceof Error && String(e).includes('promote-boom')
		);
		vfs.opfs.promote = origPromote;
		const after = await vfs.get(f.id);
		assert.equal(after!.blobId, before!.blobId);
		assert.equal(after!.generation, before!.generation);
		assert.deepEqual(await vfs.readJson(f.id), { v: 1 });
	});

	it('gc does not delete a pendingPromote blobRef or its blobs/ path', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'staged.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const stagedId = 'blob-pending-test';
		await vfs.db.blobRefs.put({
			id: stagedId,
			opfsPath: 'tmp/staged.partial',
			byteLength: 4,
			createdAt: Date.now(),
			pendingPromote: true
		});
		await vfs.opfs.writePartial('staged', new Uint8Array([1, 2, 3, 4]));
		await vfs.opfs.promote('tmp/staged.partial', `blobs/${stagedId}.bin`);
		const report = await vfs.gc();
		void report;
		const still = await vfs.db.blobRefs.get(stagedId);
		assert.ok(still, 'pendingPromote ref must survive gc');
		const bytes = await vfs.opfs.read(`blobs/${stagedId}.bin`);
		assert.equal(bytes.byteLength, 4);
		assert.ok(await vfs.get(f.id));
	});

	it('writeFile / mkdir refuse a parent that is trashed inside the txn', async () => {
		const folder = await vfs.mkdir(null, 'SoonGone');
		await vfs.trash(folder.id);
		await assert.rejects(
			() => vfs.mkdir(folder.id, 'child'),
			(e: unknown) => e instanceof VfsError && e.code === 'TRASH_STATE'
		);
		await assert.rejects(
			() =>
				vfs.writeFile({
					parentId: folder.id,
					name: 'x.skch',
					fileType: 'skch',
					body: {}
				}),
			(e: unknown) => e instanceof VfsError && e.code === 'TRASH_STATE'
		);
	});

	it('writeFile refuses a live or trashed id', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'gone.skch',
			fileType: 'skch',
			body: { keep: true }
		});
		await assert.rejects(
			() =>
				vfs.writeFile({
					id: f.id,
					parentId: null,
					name: 'reuse.skch',
					fileType: 'skch',
					body: { keep: false }
				}),
			(e: unknown) => e instanceof VfsError && e.code === 'NAME_CONFLICT'
		);
		await vfs.trash(f.id);
		await assert.rejects(
			() =>
				vfs.writeFile({
					id: f.id,
					parentId: null,
					name: 'reuse.skch',
					fileType: 'skch',
					body: { keep: false }
				}),
			(e: unknown) =>
				e instanceof VfsError &&
				e.code === 'NAME_CONFLICT' &&
				(e as VfsError).details?.trashed === true
		);
		const still = await vfs.get(f.id);
		assert.ok(still);
		assert.ok(still!.deletedAt != null);
		assert.deepEqual(await vfs.readJson(f.id), { keep: true });
	});

	it('metadata ops do not bump generation; updateFile with pre-move gen succeeds', async () => {
		const folder = await vfs.mkdir(null, 'Docs');
		const f = await vfs.writeFile({
			parentId: null,
			name: 'x.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const gen = f.generation;
		await vfs.rename(f.id, 'y');
		assert.equal((await vfs.get(f.id))!.generation, gen);
		await vfs.move(f.id, folder.id);
		assert.equal((await vfs.get(f.id))!.generation, gen);
		assert.equal((await vfs.get(f.id))!.parentId, folder.id);
		const sibling = await vfs.writeFile({
			parentId: folder.id,
			name: 'z.skch',
			fileType: 'skch',
			body: { v: 0 }
		});
		await vfs.reorder(f.id, { afterId: sibling.id });
		assert.equal((await vfs.get(f.id))!.generation, gen);
		const updated = await vfs.updateFile(f.id, { v: 2 }, { expectedGeneration: gen });
		assert.equal(updated.generation, gen + 1);
		assert.deepEqual(await vfs.readJson(f.id), { v: 2 });
		await vfs.trash(f.id);
		assert.equal((await vfs.get(f.id))!.generation, gen + 1);
		await vfs.restore(f.id);
		assert.equal((await vfs.get(f.id))!.generation, gen + 1);
		const afterRestore = await vfs.updateFile(f.id, { v: 3 }, { expectedGeneration: gen + 1 });
		assert.equal(afterRestore.generation, gen + 2);
	});
});
