import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, createMemoryOpfs, resetSharedVfsForTests, PROJECT_PACK_META } from '../src/index.ts';
import { buildStorageTree, packBadges, subtreeBytes } from '../src/ui/storageInspect.ts';
import type { OpfsBlobStore } from '../src/opfs.ts';

const enc = new TextEncoder();

function rangeStore(): OpfsBlobStore {
	const base = createMemoryOpfs();
	return {
		...base,
		async readRange(path, offset, length, contentType) {
			const all = await base.read(path);
			return new Blob([all.subarray(offset, offset + length) as BlobPart], {
				type: contentType ?? 'application/octet-stream'
			});
		}
	};
}

describe('storage inspect', () => {
	it('folder sizes sum their descendants so the map reflects what a delete frees', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `si-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const outer = await vfs.mkdir(null, 'outer');
		const inner = await vfs.mkdir(outer.id, 'inner');
		await vfs.writeFile({ parentId: outer.id, name: 'a.bin', body: new Uint8Array(1000) });
		await vfs.writeFile({ parentId: inner.id, name: 'b.bin', body: new Uint8Array(3000) });

		const tree = await buildStorageTree(vfs, null);
		const outerNode = tree.find((t) => t.name === 'outer')!;
		assert.equal(outerNode.size, 4000, 'folder size includes nested children');
		assert.equal(await subtreeBytes(vfs, outer.id), 4000);

		const innerNode = outerNode.children!.find((c) => c.name === 'inner')!;
		assert.equal(innerNode.size, 3000);
		await vfs.db.delete();
	});

	it('tags packs and projects so the inspector can outline them differently', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `si2-${Date.now()}-${Math.random()}`,
			opfs: rangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const proj = await vfs.mkdir(null, 'Proj');
		await vfs.db.nodes.update(proj.id, { meta: { [PROJECT_PACK_META]: true } });
		const nodes = await vfs.writeFiles(
			Array.from({ length: 6 }, (_, i) => ({
				parentId: proj.id,
				name: `p-${i}.bin`,
				body: enc.encode(`p${i}`)
			})),
			{ pack: true }
		);
		await vfs.writeFile({ parentId: null, name: 'loose.bin', body: new Uint8Array(500) });

		const tree = await buildStorageTree(vfs, null);
		const projNode = tree.find((t) => t.name === 'Proj')!;
		assert.equal(projNode.group, 'project', 'project folder is tagged');
		assert.ok(projNode.children!.every((c) => c.group === 'pack'), 'members tagged as packed');
		assert.equal(tree.find((t) => t.name === 'loose.bin')!.group, 'plain');

		const badges = await packBadges(vfs, nodes.map((n) => n.id));
		assert.ok([...badges.values()].every((b) => b.packed), 'listing rows can show pack membership');
		assert.ok([...badges.values()].every((b) => b.packPath?.startsWith('packs/')));
		await vfs.db.delete();
	});

	it('reports unpacked files as not packed', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `si3-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const node = await vfs.writeFile({ parentId: null, name: 'x.bin', body: new Uint8Array(10) });
		const badges = await packBadges(vfs, [node.id]);
		assert.equal(badges.get(node.id)!.packed, false);
		assert.equal(badges.get(node.id)!.packPath, undefined);
		await vfs.db.delete();
	});
});
