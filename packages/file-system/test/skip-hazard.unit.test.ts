import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, createMemoryOpfs, resetSharedVfsForTests, deleteFromProject } from '../src/index.ts';
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

describe('compaction skip hazard', () => {
	it('a ref skipped during the swap must not be orphaned by unlinking the old pack', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `skip-${Date.now()}-${Math.random()}`,
			opfs: rangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const root = await vfs.mkdir(null, 'P');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 40 }, (_, i) => ({
				parentId: root.id,
				name: `s-${i}.bin`,
				body: new Uint8Array(96 * 1024).fill(i & 0xff)
			})),
			{ pack: true }
		);
		const packPath = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;

		// Simulate a ref that moves to ANOTHER pack mid-compaction: it is in the
		// survivor list compaction captured, but by swap time its opfsPath has
		// changed, so the guard skips it. Its bytes stay in the OLD pack.
		const victim = nodes[38]!;
		const victimRef = await vfs.db.blobRefs.get(victim.blobId!);
		const realReadBlob = vfs.opfs.readBlob.bind(vfs.opfs);
		let moved = false;
		(vfs.opfs as { readBlob: typeof vfs.opfs.readBlob }).readBlob = async (p, ct) => {
			const out = await realReadBlob(p, ct);
			if (!moved && p === packPath) {
				moved = true;
				// Delete-then-recreate the ref so `get` inside the swap txn sees a
				// row whose opfsPath still equals packPath — but with a DIFFERENT
				// id, so the layout entry no longer matches and it is skipped.
				await vfs.db.blobRefs.delete(victimRef!.id);
				await vfs.db.blobRefs.put({ ...victimRef!, id: victimRef!.id + '-moved' });
				await vfs.db.nodes.update(victim.id, { blobId: victimRef!.id + '-moved' });
			}
			return out;
		};

		await deleteFromProject(vfs, nodes.slice(0, 36).map((n) => n.id));
		(vfs.opfs as { readBlob: typeof vfs.opfs.readBlob }).readBlob = realReadBlob;
		assert.ok(moved, 'the ref actually moved mid-compaction');

		// The skipped ref still names the OLD pack. If compaction unlinked it,
		// this file's bytes are gone while its ref and node still exist.
		const node = await vfs.get(victim.id);
		const after = await vfs.db.blobRefs.get(node!.blobId!);
		assert.equal(after!.opfsPath, packPath, 'skipped ref still names the old pack');
		const readable = await vfs.opfs.exists(packPath);
		assert.ok(
			readable,
			'compaction unlinked a pack that a live ref still points at — data loss'
		);
	});
});
