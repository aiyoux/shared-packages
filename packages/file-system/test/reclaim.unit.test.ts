import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, createMemoryOpfs, resetSharedVfsForTests } from '../src/index.ts';
import type { OpfsBlobStore } from '../src/opfs.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

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

describe('reclaim', () => {
	it('emptyTrash must not destroy live members sharing a pack', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `reclaim-${Date.now()}-${Math.random()}`,
			opfs: rangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 6 }, (_, i) => ({
				parentId: folder.id, name: `e-${i}.txt`, body: enc.encode(`keep-${i}`)
			}))
		);
		const packPath = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;

		// Trash HALF the pack, then empty trash. The rest must survive.
		for (const n of nodes.slice(0, 3)) await vfs.trash(n.id);
		await vfs.emptyTrash();

		assert.equal(await vfs.opfs.exists(packPath), true, 'pack survives: 3 members still live');
		for (let i = 3; i < 6; i++) {
			assert.equal(dec.decode(await vfs.readBytes(nodes[i]!.id)), `keep-${i}`);
		}
		await vfs.db.delete();
	});

	it('emptyTrash reclaims the pack when every member is trashed', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `reclaim2-${Date.now()}-${Math.random()}`,
			opfs: rangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 4 }, (_, i) => ({
				parentId: folder.id, name: `a-${i}.txt`, body: enc.encode(`a${i}`)
			}))
		);
		const packPath = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;
		for (const n of nodes) await vfs.trash(n.id);
		await vfs.emptyTrash();
		assert.equal(await vfs.opfs.exists(packPath), false, 'whole pack reclaimed');
		await vfs.db.delete();
	});

	it('gc sweeps an orphaned pack file but spares a live one', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `sweep-${Date.now()}-${Math.random()}`,
			opfs: rangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 4 }, (_, i) => ({
				parentId: folder.id, name: `s-${i}.txt`, body: enc.encode(`s${i}`)
			}))
		);
		const livePack = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;

		// A pack file on disk that no ref names: what a crashed pack write
		// leaves behind. Nothing else in the system would ever reclaim it.
		await vfs.opfs.writeFinal('packs/orphan-crash.bin', enc.encode('leaked bytes'));

		const report = await vfs.gc();
		assert.equal(
			await vfs.opfs.exists('packs/orphan-crash.bin'),
			false,
			'orphaned pack reclaimed'
		);
		assert.ok(report.orphanOpfsRemoved >= 1);
		assert.equal(await vfs.opfs.exists(livePack), true, 'live pack untouched');
		assert.equal(dec.decode(await vfs.readBytes(nodes[2]!.id)), 's2', 'members still read');
		await vfs.db.delete();
	});

	it('gc reclaims a pack whose members were all released', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `reclaim3-${Date.now()}-${Math.random()}`,
			opfs: rangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 4 }, (_, i) => ({
				parentId: folder.id, name: `g-${i}.txt`, body: enc.encode(`g${i}`)
			}))
		);
		const packPath = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;
		// Drop the NODES only, leaving refs orphaned — what a crashed delete looks like.
		await vfs.db.nodes.bulkDelete(nodes.map((n) => n.id));
		const report = await vfs.gc();
		assert.ok(report.unreferencedBlobsRemoved >= 4, 'orphan refs swept');
		assert.equal(await vfs.opfs.exists(packPath), false, 'pack file reclaimed by gc');
		await vfs.db.delete();
	});
});
