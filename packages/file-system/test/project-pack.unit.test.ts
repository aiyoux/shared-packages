import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	createVfs,
	createMemoryOpfs,
	resetSharedVfsForTests,
	readProjectManifest,
	checkProjectPacks,
	deleteFromProject,
	checkFilesystem
} from '../src/index.ts';
import type { OpfsBlobStore } from '../src/opfs.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Memory store plus readRange, so the packed path is reachable in node. */
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

async function projectWithPack(tag: string, memberBytes = 4096, count = 40) {
	resetSharedVfsForTests();
	const vfs = createVfs({
		dbName: `pp-${tag}-${Date.now()}-${Math.random()}`,
		opfs: rangeStore(),
		requestPersist: false
	});
	await vfs.ready();
	const root = await vfs.mkdir(null, 'MyProject');
	const src = await vfs.mkdir(root.id, 'src');
	const nodes = await vfs.writeFiles(
		Array.from({ length: count }, (_, i) => {
			const b = new Uint8Array(memberBytes);
			b[0] = i & 0xff;
			b[memberBytes - 1] = 0xee;
			return { parentId: src.id, name: `f-${i}.bin`, body: b };
		}),
		{ pack: true }
	);
	return { vfs, root, src, nodes };
}

describe('project packs', () => {
	it('manifest describes the pack collection and its dead space', async () => {
		const { vfs, root, nodes } = await projectWithPack('manifest');
		const before = await readProjectManifest(vfs, root.id);
		assert.equal(before.packPaths.length, 1, 'one pack for one chunk');
		assert.equal(before.packedFiles, nodes.length);
		assert.equal(before.standaloneFiles, 0);
		assert.equal(before.deadBytes, 0, 'nothing dead yet');
		assert.equal(before.packBytesOnDisk, before.packedBytes);

		// Remove half the members WITHOUT compacting: the pack keeps its size,
		// and the difference is dead space the manifest must surface.
		for (const n of nodes.slice(0, 20)) await vfs.permanentDelete(n.id);
		const after = await readProjectManifest(vfs, root.id);
		assert.equal(after.packedFiles, 20);
		assert.ok(after.deadBytes > 0, 'dead space is visible, not silent');
		assert.equal(after.packBytesOnDisk, before.packBytesOnDisk, 'pack file unchanged');
		await vfs.db.delete();
	});

	it('integrity check passes on a healthy project and names real damage', async () => {
		const { vfs, root, nodes } = await projectWithPack('integrity');
		const clean = await checkProjectPacks(vfs, root.id);
		assert.equal(clean.ok, true, 'healthy project reports ok');
		assert.equal(clean.issues.length, 0);
		assert.equal(clean.packPaths.length, 1);

		// Corrupt: point a member past the end of its pack.
		const ref = await vfs.db.blobRefs.get(nodes[0]!.blobId!);
		await vfs.db.blobRefs.put({ ...ref!, packOffset: 999_999 });
		const damaged = await checkProjectPacks(vfs, root.id);
		assert.equal(damaged.ok, false);
		assert.ok(
			damaged.issues.some((i) => i.kind === 'short-pack'),
			'out-of-bounds member is reported'
		);
		await vfs.db.delete();
	});

	it('integrity check catches a pack that vanished under live members', async () => {
		const { vfs, root, nodes } = await projectWithPack('missing');
		const ref = await vfs.db.blobRefs.get(nodes[0]!.blobId!);
		await vfs.opfs.remove(ref!.opfsPath);
		const report = await checkProjectPacks(vfs, root.id);
		assert.equal(report.ok, false);
		assert.ok(report.issues.some((i) => i.kind === 'missing-pack'));
		await vfs.db.delete();
	});

	it('delete compacts, reclaims space, and reports its stages', async () => {
		// Members big enough that removing most of them clears the reclaim
		// threshold.
		const { vfs, root, nodes } = await projectWithPack('compact', 96 * 1024, 40);
		const before = await readProjectManifest(vfs, root.id);

		const stages: string[] = [];
		const result = await deleteFromProject(
			vfs,
			nodes.slice(0, 36).map((n) => n.id),
			{ onProgress: (ev) => stages.push(ev.stage) }
		);

		assert.equal(result.deleted, 36);
		assert.equal(result.compactedPacks, 1, 'the mostly-dead pack was rewritten');
		assert.ok(result.reclaimedBytes > 0, 'space actually came back');

		// The stage sequence is what the UI surfaces.
		assert.ok(stages.includes('wiping'));
		assert.ok(stages.includes('compacting'));
		assert.ok(stages.includes('verifying'));
		assert.equal(stages[stages.length - 1], 'done');

		const after = await readProjectManifest(vfs, root.id);
		assert.ok(
			after.packBytesOnDisk < before.packBytesOnDisk,
			'pack file is smaller on disk after compaction'
		);
		assert.ok(after.deadBytes < before.packedBytes, 'dead space reclaimed');

		// The survivors must still read their own bytes at their new offsets.
		for (const n of nodes.slice(36)) {
			const bytes = await vfs.readBytes(n.id);
			assert.equal(bytes.byteLength, 96 * 1024);
			assert.equal(bytes[bytes.byteLength - 1], 0xee, 'member content intact after move');
		}
		assert.equal((await checkProjectPacks(vfs, root.id)).ok, true, 'still consistent');
		await vfs.db.delete();
	});

	it('deleting every member drops the pack without compacting', async () => {
		const { vfs, root, nodes } = await projectWithPack('all', 96 * 1024, 12);
		const path = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;
		const result = await deleteFromProject(vfs, nodes.map((n) => n.id));
		assert.equal(result.compactedPacks, 0, 'nothing to rewrite when nothing survives');
		assert.equal(await vfs.opfs.exists(path), false, 'pack file unlinked outright');
		assert.equal((await readProjectManifest(vfs, root.id)).packPaths.length, 0);
		await vfs.db.delete();
	});

	// NOTE: this covers the `!current` half of the swap guard — updateFile
	// deletes the old ref, so a blind put would resurrect it. The
	// `opfsPath !== packPath` half guards a ref that moved to ANOTHER pack
	// mid-compaction, which nothing in the codebase can currently do (packs are
	// only created by writeFiles, never re-homed). It is kept as defence for
	// when a second pack-writing path exists.
	it('a concurrent rewrite is not dragged into the compacted pack', async () => {
		// updateFile moves a node to its own standalone blob. If compaction
		// blind-wrote its precomputed layout it would resurrect a stale pointer
		// over those new bytes.
		const { vfs, root, nodes } = await projectWithPack('race', 96 * 1024, 40);
		const survivor = nodes[38]!;
		const staleRefId = (await vfs.get(survivor.id))!.blobId!;

		// Rewrite AFTER compaction has read the survivor list but BEFORE the
		// swap: the layout compaction computed still names the survivor's old
		// packed ref, which by then belongs to nothing.
		const realReadBlob = vfs.opfs.readBlob.bind(vfs.opfs);
		let rewritten = false;
		(vfs.opfs as { readBlob: typeof vfs.opfs.readBlob }).readBlob = async (path, ct) => {
			const out = await realReadBlob(path, ct);
			if (!rewritten && path.startsWith('packs/')) {
				rewritten = true;
				await vfs.updateFile(survivor.id, enc.encode('rewritten'), { force: true });
			}
			return out;
		};

		await deleteFromProject(vfs, nodes.slice(0, 36).map((n) => n.id));
		(vfs.opfs as { readBlob: typeof vfs.opfs.readBlob }).readBlob = realReadBlob;
		assert.ok(rewritten, 'the concurrent rewrite actually ran mid-compaction');
		assert.equal(
			await vfs.db.blobRefs.get(staleRefId),
			undefined,
			'the old packed ref is gone, so a blind swap would resurrect it'
		);

		const bytes = await vfs.readBytes(survivor.id);
		assert.equal(dec.decode(bytes), 'rewritten', 'the newer content survived compaction');
		assert.equal((await checkProjectPacks(vfs, root.id)).ok, true);
		await vfs.db.delete();
	});
});

describe('filesystem integrity check', () => {
	it('passes on a healthy filesystem and reports orphaned packs', async () => {
		const { vfs, nodes } = await projectWithPack('fscheck');
		const clean = await checkFilesystem(vfs);
		assert.equal(clean.ok, true, 'healthy filesystem is ok');

		// A pack file nothing points at: wasted space the user should be told
		// about rather than left to wonder where their storage went.
		await vfs.opfs.writeFinal('packs/stray.bin', enc.encode('nobody owns me'));
		const withOrphan = await checkFilesystem(vfs);
		assert.equal(withOrphan.ok, false);
		assert.ok(withOrphan.issues.some((i) => i.kind === 'orphan-pack'));

		// And it still sees real damage to live files.
		const ref = await vfs.db.blobRefs.get(nodes[1]!.blobId!);
		await vfs.db.blobRefs.put({ ...ref!, packOffset: 10 ** 9 });
		const damaged = await checkFilesystem(vfs);
		assert.ok(damaged.issues.some((i) => i.kind === 'short-pack'));
		await vfs.db.delete();
	});

	it('does not call a trashed file\'s pack an orphan', async () => {
		// A delete is not corruption. Trashed files keep their blobRefs so they
		// can be restored, so their pack is still owned — and gc() agrees, which
		// is why "delete the folder" could never clear the report it caused.
		const { vfs, root, nodes } = await projectWithPack('fstrash');
		assert.equal((await checkFilesystem(vfs)).ok, true);

		await vfs.trash(root.id);
		const trashed = await checkFilesystem(vfs);
		assert.equal(
			trashed.issues.filter((i) => i.kind === 'orphan-pack').length,
			0,
			'the pack is still held by the trashed files'
		);

		await vfs.restore(root.id);
		assert.equal((await checkFilesystem(vfs)).ok, true, 'and the bytes were really still there');
		assert.equal((await vfs.readBytes(nodes[0]!.id)).byteLength, 4096);

		// A pack no ref names at all is still garbage, and still reported.
		await vfs.opfs.writeFinal('packs/stray.bin', enc.encode('nobody owns me'));
		const withStray = await checkFilesystem(vfs);
		assert.equal(withStray.issues.filter((i) => i.kind === 'orphan-pack').length, 1);

		// Exactly the set gc() reclaims — check and sweep must not disagree.
		await vfs.gc();
		assert.equal((await checkFilesystem(vfs)).ok, true);
		await vfs.db.delete();
	});

	it('reports a file whose storage vanished', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `fsmissing-${Date.now()}-${Math.random()}`,
			opfs: rangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const node = await vfs.writeFile({ parentId: null, name: 'lonely.txt', body: enc.encode('x') });
		const ref = await vfs.db.blobRefs.get(node.blobId!);
		await vfs.opfs.remove(ref!.opfsPath);
		const report = await checkFilesystem(vfs);
		assert.equal(report.ok, false);
		assert.ok(report.issues.some((i) => i.kind === 'missing-pack' && i.nodeId === node.id));
		await vfs.db.delete();
	});
});
