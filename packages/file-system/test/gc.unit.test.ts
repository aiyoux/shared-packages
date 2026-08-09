import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests } from '../src/index.ts';

describe('VfsService.gc', () => {
	let vfs: ReturnType<typeof createVfs>;

	beforeEach(async () => {
		resetSharedVfsForTests();
		// Short grace so expired orphans are collectable without sleeping long
		vfs = createVfs({
			dbName: `test-gc-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			graceMs: 50
		});
		await vfs.ready();
	});

	it('removes unreferenced blobRefs after permanent delete', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'gone.skch',
			fileType: 'skch',
			body: { z: 1 }
		});
		const blobId = f.blobId!;
		await vfs.trash(f.id);
		await vfs.permanentDelete(f.id, { recursive: true });
		// permanentDelete already removes blobRef; seed an extra orphan to collect
		await vfs.opfs.writePartial('orphan-w', new TextEncoder().encode('x'));
		await vfs.db.blobRefs.put({
			id: 'orphan-blob',
			opfsPath: 'blobs/orphan-blob.bin',
			byteLength: 1,
			createdAt: Date.now() - 10_000,
			pending: false,
			pendingPromote: false
		});
		// Write actual OPFS path so remove succeeds
		await vfs.opfs.promote('tmp/orphan-w.partial', 'blobs/orphan-blob.bin').catch(async () => {
			// memory opfs promote path may need writePartial + promote; write via store
			const { tmpPath } = await vfs.opfs.writePartial('o2', new TextEncoder().encode('x'));
			await vfs.opfs.promote(tmpPath, 'blobs/orphan-blob.bin');
		});

		const report = await vfs.gc();
		assert.ok(
			report.orphanBlobRefsRemoved + report.unreferencedBlobsRemoved >= 1,
			JSON.stringify(report)
		);
		assert.equal(await vfs.db.blobRefs.get('orphan-blob'), undefined);
		void blobId;
	});

	it('skips blobRefs protected by an active write lease (GC-during-write)', async () => {
		const blobId = 'in-flight-write';
		const { tmpPath } = await vfs.opfs.writePartial('w1', new TextEncoder().encode('partial'));
		await vfs.db.blobRefs.put({
			id: blobId,
			opfsPath: tmpPath,
			byteLength: 7,
			createdAt: Date.now(),
			pending: true,
			pendingPromote: true
		});
		await vfs.db.leases.put({
			key: `write:${blobId}`,
			owner: 'writer-a',
			expiresAt: Date.now() + 60_000
		});

		const report = await vfs.gc();
		assert.equal(report.orphanBlobRefsRemoved, 0);
		assert.ok(await vfs.db.blobRefs.get(blobId));
		assert.ok(await vfs.db.leases.get(`write:${blobId}`));
	});

	it('collects orphan after lease expires and grace elapses', async () => {
		const blobId = 'expired-write';
		const { tmpPath } = await vfs.opfs.writePartial('w2', new TextEncoder().encode('old'));
		await vfs.db.blobRefs.put({
			id: blobId,
			opfsPath: tmpPath,
			byteLength: 3,
			createdAt: Date.now() - 10_000,
			pending: true,
			pendingPromote: true
		});
		await vfs.db.leases.put({
			key: `write:${blobId}`,
			owner: 'writer-b',
			expiresAt: Date.now() - 1 // already expired
		});

		const report = await vfs.gc();
		assert.ok(report.orphanBlobRefsRemoved >= 1 || report.expiredLeasesRemoved >= 1);
		assert.equal(await vfs.db.blobRefs.get(blobId), undefined);
	});

	it('does not delete live file blobs', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'live.skch',
			fileType: 'skch',
			body: { keep: true }
		});
		const before = await vfs.db.blobRefs.get(f.blobId!);
		assert.ok(before);
		await vfs.gc();
		const after = await vfs.db.blobRefs.get(f.blobId!);
		assert.ok(after);
		assert.deepEqual(await vfs.readJson(f.id), { keep: true });
	});
});
