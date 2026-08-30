import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, createMemoryOpfs, resetSharedVfsForTests } from '../src/index.ts';
import type { OpfsBlobStore } from '../src/opfs.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function rangeStore(onWriteFinal?: (path: string) => Promise<void>): OpfsBlobStore {
	const base = createMemoryOpfs();
	return {
		...base,
		async writeFinal(path, data) {
			const result = await base.writeFinal(path, data as never);
			if (onWriteFinal) await onWriteFinal(path);
			return result;
		},
		async writeAtomic(path, data) {
			const result = await base.writeAtomic!(path, data as never);
			if (onWriteFinal) await onWriteFinal(path);
			return result;
		},
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
			})),
			{ pack: true }
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
			})),
			{ pack: true }
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
			})),
			{ pack: true }
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
			})),
			{ pack: true }
		);
		const packPath = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;
		// Drop the NODES only, leaving refs orphaned — what a crashed delete looks like.
		await vfs.db.nodes.bulkDelete(nodes.map((n) => n.id));
		const report = await vfs.gc();
		assert.ok(report.unreferencedBlobsRemoved >= 4, 'orphan refs swept');
		assert.equal(await vfs.opfs.exists(packPath), false, 'pack file reclaimed by gc');
		await vfs.db.delete();
	});
	it('a sweep during a packed write must not reclaim the live pack', async () => {
		// sweepOnLoad runs compactStalePacks a couple of seconds after any page
		// load, and an extract runs in a worker against the same store — so a
		// sweep landing mid-extract is ordinary, not exotic.
		//
		// A pending ref carries byteLength 0 until the confirm txn, so the
		// dead-space arithmetic read an in-flight pack as 100% garbage and
		// "reclaimed" it: the pack was rewritten to zero bytes and every member
		// of the chunk lost its content.
		resetSharedVfsForTests();
		let vfs!: ReturnType<typeof createVfs>;
		let swept = 0;
		const opfs = rangeStore(async (path) => {
			if (path.startsWith('packs/') && swept++ === 0) await vfs.compactStalePacks();
		});
		vfs = createVfs({
			dbName: `reclaim-inflight-${Date.now()}-${Math.random()}`,
			opfs,
			requestPersist: false
		});
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'extract');
		// Over COMPACT_MIN_RECLAIM_BYTES (1MB), so the pack is a candidate at all.
		const SIZE = 8192;
		const nodes = await vfs.writeFiles(
			Array.from({ length: 300 }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.bin`,
				body: new Uint8Array(SIZE).fill(i & 0xff)
			})),
			{ pack: true }
		);
		assert.equal(swept, 1, 'the sweep really did run mid-write');

		for (const n of nodes) {
			const bytes = await vfs.readBytes(n.id);
			assert.equal(bytes.byteLength, SIZE, `${n.name} kept its bytes`);
		}
		const ref = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!;
		assert.notEqual(ref.packOffset, undefined, 'and they are still packed');
		await vfs.db.delete();
	});
});
