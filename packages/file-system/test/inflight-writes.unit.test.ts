import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	createVfs,
	createMemoryOpfs,
	resetSharedVfsForTests,
	checkFilesystem,
	readProjectManifest
} from '../src/index.ts';
import type { OpfsBlobStore } from '../src/opfs.ts';
import type { VfsService } from '../src/vfs.ts';

/**
 * Maintenance operations vs a write that has not landed yet.
 *
 * Every op here rewrites storage that live files point at, and each decides
 * what to move by reading `blobRef.byteLength`. A reserved-but-unwritten ref
 * carries `byteLength: 0` and `pending: true` — the length is not yet TRUE,
 * not zero — so an op that trusts it concludes the member is empty, or that
 * its pack is entirely dead space, and then acts on that by overwriting live
 * bytes.
 *
 * These are not exotic interleavings: sweepOnLoad() fires a couple of seconds
 * after every page load and extraction runs in a worker against the same
 * store, so "a sweep lands mid-write" is the ordinary case.
 */

const SIZE = 8192;
/** Over COMPACT_MIN_RECLAIM_BYTES, so the pack is a compaction candidate at all. */
const MEMBERS = 300;

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
			const result = await base.writeAtomic(path, data as never);
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

/**
 * Run `duringPackWrite` at the moment a pack file has hit the store but its
 * members' refs are still pending, then assert every member kept its bytes.
 */
async function packWriteInterruptedBy(
	tag: string,
	duringPackWrite: (vfs: VfsService, nodeIds: string[]) => Promise<unknown>
) {
	resetSharedVfsForTests();
	let vfs!: VfsService;
	let fired = 0;
	const opfs = rangeStore(async (path) => {
		if (!path.startsWith('packs/') || fired++ > 0) return;
		const rows = await vfs.db.nodes.toArray();
		await duringPackWrite(
			vfs,
			rows.filter((n) => n.kind === 'file').map((n) => n.id)
		);
	});
	vfs = createVfs({
		dbName: `inflight-${tag}-${Date.now()}-${Math.random()}`,
		opfs,
		requestPersist: false
	});
	await vfs.ready();
	const folder = await vfs.mkdir(null, 'extract');
	const nodes = await vfs.writeFiles(
		Array.from({ length: MEMBERS }, (_, i) => ({
			parentId: folder.id,
			name: `m-${i}.bin`,
			body: new Uint8Array(SIZE).fill(i & 0xff)
		})),
		{ pack: true }
	);
	assert.equal(fired, 1, 'the maintenance op really did run mid-write');

	for (const [i, n] of nodes.entries()) {
		const bytes = await vfs.readBytes(n.id);
		assert.equal(bytes.byteLength, SIZE, `${n.name} kept its length`);
		assert.equal(bytes[0], i & 0xff, `${n.name} kept its content`);
	}
	assert.equal((await checkFilesystem(vfs)).ok, true, 'and the filesystem checks out');
	await vfs.db.delete();
}

describe('maintenance must not touch a write in flight', () => {
	it('compactStalePacks — the sweep that runs on every page load', async () => {
		await packWriteInterruptedBy('sweep', (vfs) => vfs.compactStalePacks());
	});

	it('compactPacks — the same rewrite reached through the delete path', async () => {
		await packWriteInterruptedBy('compact', async (vfs) => {
			const refs = await vfs.db.blobRefs.toArray();
			return vfs.compactPacks(refs.filter((r) => r.packOffset != null).map((r) => r.opfsPath));
		});
	});

	it('repackNodes — user-initiated "pack these files"', async () => {
		await packWriteInterruptedBy('repack', (vfs, ids) => vfs.repackNodes(ids));
	});

	it('unpackNodes — user-initiated "turn packing off"', async () => {
		await packWriteInterruptedBy('unpack', (vfs, ids) => vfs.unpackNodes(ids));
	});

	it('gc — must not unlink a pack whose members are still pending', async () => {
		await packWriteInterruptedBy('gc', (vfs) => vfs.gc());
	});
});

describe('the check and the sweep must agree on what is garbage', () => {
	/**
	 * checkFilesystem reports; gc() acts. They answer the same question — does
	 * any blobRef name this path? — and while they disagreed the report named
	 * files that no action available to the user could clear, because the
	 * things it called garbage were still owned.
	 */
	it('everything reported as an orphan is exactly what gc removes', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `agree-${Date.now()}-${Math.random()}`,
			opfs: rangeStore(),
			requestPersist: false
		});
		await vfs.ready();

		const live = await vfs.mkdir(null, 'live');
		const liveNodes = await vfs.writeFiles(
			Array.from({ length: 8 }, (_, i) => ({
				parentId: live.id,
				name: `a-${i}.bin`,
				body: new Uint8Array(512).fill(i)
			})),
			{ pack: true }
		);
		const binned = await vfs.mkdir(null, 'binned');
		const binnedNodes = await vfs.writeFiles(
			Array.from({ length: 8 }, (_, i) => ({
				parentId: binned.id,
				name: `b-${i}.bin`,
				body: new Uint8Array(512).fill(i)
			})),
			{ pack: true }
		);
		await vfs.trash(binned.id);
		// Debris a crashed pack write leaves: a pack file no blobRef names.
		await vfs.opfs.writeFinal('packs/stray.bin', new Uint8Array(64));

		const before = await checkFilesystem(vfs);
		const orphans = before.issues.filter((i) => i.kind === 'orphan-pack');
		assert.deepEqual(
			orphans.map((i) => i.packPath),
			['packs/stray.bin'],
			"the trashed folder's pack is still owned — trashing is not corruption"
		);
		assert.equal(before.issues.length, orphans.length, 'and nothing else is wrong');

		const swept = await vfs.gc();
		assert.equal(swept.orphanOpfsRemoved, orphans.length, 'gc removed exactly the reported set');
		assert.equal(await vfs.opfs.exists('packs/stray.bin'), false);
		assert.equal((await checkFilesystem(vfs)).ok, true, 'and the report is clean afterwards');

		for (const n of liveNodes) {
			assert.equal((await vfs.readBytes(n.id)).byteLength, 512, `${n.name} untouched`);
		}
		// The trashed files are still restorable — gc did not take their pack.
		await vfs.restore(binned.id);
		for (const n of binnedNodes) {
			assert.equal((await vfs.readBytes(n.id)).byteLength, 512, `${n.name} restorable`);
		}
		await vfs.db.delete();
	});
});

describe('a trashed member is owned, not dead', () => {
	/**
	 * The manifest's "Reclaimable" figure drives a user's decision about
	 * whether to act. Counting a trashed member's bytes as dead promises space
	 * that nothing but emptying the trash can return — the same live-only
	 * reading that made the integrity check report healthy packs as orphans.
	 */
	it('does not count trashed bytes as reclaimable', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `dead-${Date.now()}-${Math.random()}`,
			opfs: rangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const root = await vfs.mkdir(null, 'proj');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 10 }, (_, i) => ({
				parentId: root.id,
				name: `f-${i}.bin`,
				body: new Uint8Array(4096).fill(i)
			})),
			{ pack: true }
		);
		assert.equal((await readProjectManifest(vfs, root.id)).deadBytes, 0);

		for (const n of nodes.slice(0, 5)) await vfs.trash(n.id);
		const trashed = await readProjectManifest(vfs, root.id);
		assert.equal(trashed.packedFiles, 5, 'five live members remain');
		assert.equal(trashed.deadBytes, 0, 'the trashed five are still holding their bytes');

		// Emptying the trash is what ends the ownership, and only then do those
		// bytes become dead. They stay on disk here because 20KB is under the
		// floor that makes rewriting a pack worth the IO — dead but not yet
		// worth reclaiming is a real state, and the number should say so.
		await vfs.emptyTrash();
		assert.equal(
			(await readProjectManifest(vfs, root.id)).deadBytes,
			5 * 4096,
			'now they are genuinely dead'
		);
		for (const n of nodes.slice(5)) {
			assert.equal((await vfs.readBytes(n.id)).byteLength, 4096, `${n.name} survived`);
		}
		await vfs.db.delete();
	});
});

describe('two tabs sweeping at once', () => {
	/**
	 * sweepOnLoad runs compactStalePacks on EVERY page load, and it took no
	 * lock while gc() next door claimed `gc:run`. Two tabs opening together
	 * therefore rewrote the same pack at once: the loser's swap found every ref
	 * already repointed at the winner's new pack, skipped them all, and left
	 * the pack it had just written referenced by nothing.
	 *
	 * That is an orphan with every live file healthy — the state that is
	 * hardest to explain from the outside, because deleting files cannot clear
	 * it and nothing is actually damaged.
	 *
	 * The interleaving is forced rather than raced: the second tab is let in at
	 * the moment the first has read its survivors and written its new pack but
	 * has not yet swapped the refs. Left to chance the two runs serialise and
	 * the window never opens, which is exactly why this needs a lock rather
	 * than luck.
	 */
	it('the second tab stands down instead of orphaning its rewrite', async () => {
		resetSharedVfsForTests();
		let interleave: (() => Promise<void>) | null = null;
		const opfs = rangeStore(async (path) => {
			if (!path.startsWith('packs/') || !interleave) return;
			const run = interleave;
			interleave = null; // once, and never re-entrant
			await run();
		});
		const dbName = `twotabs-${Date.now()}-${Math.random()}`;
		const tabA = createVfs({ dbName, opfs, requestPersist: false });
		const tabB = createVfs({ dbName, opfs, requestPersist: false });
		await tabA.ready();
		await tabB.ready();

		const root = await tabA.mkdir(null, 'proj');
		const N = 400;
		const nodes = await tabA.writeFiles(
			Array.from({ length: N }, (_, i) => ({
				parentId: root.id,
				name: `f-${i}.bin`,
				body: new Uint8Array(SIZE).fill(i & 0xff)
			})),
			{ pack: true }
		);
		const packPath = (await tabA.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;

		// Half the members dropped WITHOUT compacting, so the pack is genuinely
		// stale: past both the 1MB floor and the 50% dead fraction.
		for (const n of nodes.slice(0, N / 2)) await tabA.trash(n.id);
		await tabA.emptyTrash({ skipCompaction: true });
		const survivors = nodes.slice(N / 2);

		let b: { compactedPacks: number; reclaimedBytes: number } | null = null;
		interleave = async () => {
			b = await tabB.compactPacks([packPath]);
		};
		const a = await tabA.compactPacks([packPath]);

		assert.notEqual(b, null, 'the second tab really did run inside the window');
		assert.equal(
			a.compactedPacks + b!.compactedPacks,
			1,
			'one tab compacts, the other finds the pack claimed and stands down'
		);

		const named = new Set((await tabA.db.blobRefs.toArray()).map((r) => r.opfsPath));
		assert.deepEqual(
			(await tabA.opfs.listOrphans('packs')).filter((path) => !named.has(path)),
			[],
			'and no pack is left that nothing points at'
		);
		assert.equal((await checkFilesystem(tabA)).ok, true);
		for (const n of survivors) {
			assert.equal((await tabA.readBytes(n.id)).byteLength, SIZE, `${n.name} survived`);
		}
		await tabA.db.delete();
	});
});
