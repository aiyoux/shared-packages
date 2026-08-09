import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests, VfsError } from '../src/index.ts';

describe('VFS sortOrder / reorder', () => {
	let vfs: ReturnType<typeof createVfs>;

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({
			dbName: `vfs-order-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	it('assigns sortOrder on create and lists sort:order folders-first', async () => {
		const f1 = await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'b' });
		const f2 = await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		const dir = await vfs.mkdir(null, 'Zed');
		assert.equal(typeof f1.sortOrder, 'number');
		assert.equal(typeof f2.sortOrder, 'number');
		assert.equal(typeof dir.sortOrder, 'number');
		assert.ok((f1.sortOrder ?? 0) < (f2.sortOrder ?? 0));

		const ordered = await vfs.list({ parentId: null, sort: 'order' });
		assert.equal(ordered[0]?.kind, 'folder');
		assert.equal(ordered[0]?.name, 'Zed');
		const files = ordered.filter((n) => n.kind === 'file');
		assert.deepEqual(
			files.map((n) => n.name),
			['b.txt', 'a.txt']
		);
	});

	it('reorder same-parent changes list ranks (not DOM-only)', async () => {
		const a = await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		const b = await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'b' });
		const c = await vfs.writeFile({ parentId: null, name: 'c.txt', body: 'c' });

		// Move c before a (afterId = a → insert before a)
		await vfs.reorder(c.id, { afterId: a.id });
		const list = await vfs.list({ parentId: null, sort: 'order' });
		const names = list.filter((n) => n.kind === 'file').map((n) => n.name);
		assert.deepEqual(names, ['c.txt', 'a.txt', 'b.txt']);
		const ranks = list.filter((n) => n.kind === 'file').map((n) => n.sortOrder ?? 0);
		assert.ok(ranks[0]! < ranks[1]! && ranks[1]! < ranks[2]!);

		// Move a after b
		await vfs.reorder(a.id, { beforeId: b.id });
		const list2 = await vfs.list({ parentId: null, sort: 'order' });
		assert.deepEqual(
			list2.filter((n) => n.kind === 'file').map((n) => n.name),
			['c.txt', 'b.txt', 'a.txt']
		);
	});

	it('move reparent assigns append rank in new parent', async () => {
		const folder = await vfs.mkdir(null, 'dest');
		const file = await vfs.writeFile({ parentId: null, name: 'x.txt', body: 'x' });
		await vfs.move(file.id, folder.id);
		const kids = await vfs.list({ parentId: folder.id, sort: 'order' });
		assert.equal(kids.length, 1);
		assert.equal(kids[0]?.name, 'x.txt');
		assert.equal(typeof kids[0]?.sortOrder, 'number');
	});

	it('trash state blocks reorder', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 't.txt', body: 't' });
		await vfs.trash(f.id);
		await assert.rejects(
			() => vfs.reorder(f.id, { beforeId: null }),
			(e: unknown) => e instanceof VfsError && e.code === 'TRASH_STATE'
		);
	});

	it('name sort regression still works', async () => {
		await vfs.writeFile({ parentId: null, name: 'z.txt', body: 'z' });
		await vfs.writeFile({ parentId: null, name: 'm.txt', body: 'm' });
		const byName = await vfs.list({ parentId: null, sort: 'name' });
		const files = byName.filter((n) => n.kind === 'file').map((n) => n.name);
		assert.deepEqual(files, ['m.txt', 'z.txt']);
	});
});
