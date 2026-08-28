import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, createMemoryOpfs, resetSharedVfsForTests } from '../src/index.ts';
import type { OpfsBlobStore } from '../src/opfs.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * The in-memory store deliberately lacks readRange (that absence is the
 * capability gate). This wraps it with one so the packed path can be tested
 * without a browser.
 */
function rangeCapableStore(): OpfsBlobStore {
	const base = createMemoryOpfs();
	return {
		...base,
		writeFinal: (path, data) => base.writeFinal(path, data),
		async readRange(path, offset, length, contentType) {
			const all = await base.read(path);
			const view = all.subarray(offset, offset + length);
			return new Blob([view as BlobPart], {
				type: contentType ?? 'application/octet-stream'
			});
		}
	};
}

async function mk(tag: string) {
	resetSharedVfsForTests();
	const vfs = createVfs({
		dbName: `packed-${tag}-${Date.now()}-${Math.random()}`,
		opfs: rangeCapableStore(),
		requestPersist: false
	});
	await vfs.ready();
	return vfs;
}

describe('packed blobs', () => {
	it('packs a bulk write into one file and reads every member back', async () => {
		const vfs = await mk('roundtrip');
		const folder = await vfs.mkdir(null, 'p');
		const N = 40;
		const nodes = await vfs.writeFiles(
			Array.from({ length: N }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.txt`,
				body: enc.encode(`member-${i}`)
			})),
			{ pack: true }
		);
		assert.equal(nodes.length, N);

		const refs = await Promise.all(nodes.map((n) => vfs.db.blobRefs.get(n.blobId!)));
		const paths = new Set(refs.map((r) => r!.opfsPath));
		assert.equal(paths.size, 1, 'all members share one pack file');
		assert.ok([...paths][0]!.startsWith('packs/'), 'stored under packs/');
		assert.ok(
			refs.every((r) => typeof r!.packOffset === 'number'),
			'every member records its offset'
		);

		// Offsets must be distinct and sizes must be the member sizes, not the
		// pack size — a length bug here would read a neighbour's bytes.
		for (let i = 0; i < N; i++) {
			const bytes = await vfs.readBytes(nodes[i]!.id);
			assert.equal(dec.decode(bytes), `member-${i}`, `member ${i} reads its own bytes`);
			const blob = await vfs.readBlob(nodes[i]!.id);
			assert.equal(dec.decode(new Uint8Array(await blob.arrayBuffer())), `member-${i}`);
			assert.equal(nodes[i]!.size, `member-${i}`.length);
		}
		await vfs.db.delete();
	});

	it('deleting one member leaves its siblings readable', async () => {
		const vfs = await mk('delete-one');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 10 }, (_, i) => ({
				parentId: folder.id,
				name: `d-${i}.txt`,
				body: enc.encode(`payload-${i}`)
			})),
			{ pack: true }
		);
		const victim = nodes[3]!;
		const packPath = (await vfs.db.blobRefs.get(victim.blobId!))!.opfsPath;

		await vfs.trash(victim.id);
		await vfs.permanentDelete(victim.id);

		assert.equal(await vfs.opfs.exists(packPath), true, 'pack survives one member dying');
		for (const n of nodes) {
			if (n.id === victim.id) continue;
			assert.equal(dec.decode(await vfs.readBytes(n.id)), `payload-${nodes.indexOf(n)}`);
		}
		await vfs.db.delete();
	});

	it('reclaims the pack only once every member is gone', async () => {
		const vfs = await mk('reclaim');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 5 }, (_, i) => ({
				parentId: folder.id,
				name: `r-${i}.txt`,
				body: enc.encode(`r${i}`)
			})),
			{ pack: true }
		);
		const packPath = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;
		for (const n of nodes.slice(0, 4)) {
			await vfs.trash(n.id);
			await vfs.permanentDelete(n.id);
		}
		assert.equal(await vfs.opfs.exists(packPath), true, 'still one member alive');
		await vfs.trash(nodes[4]!.id);
		await vfs.permanentDelete(nodes[4]!.id);
		assert.equal(await vfs.opfs.exists(packPath), false, 'last member gone => reclaimed');
		await vfs.db.delete();
	});

	it('updateFile on a packed member keeps the pack and its siblings intact', async () => {
		const vfs = await mk('update');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 6 }, (_, i) => ({
				parentId: folder.id,
				name: `u-${i}.txt`,
				body: enc.encode(`before-${i}`)
			})),
			{ pack: true }
		);
		const packPath = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;

		// This is the trace that would have destroyed the archive: edit one
		// extracted file and the old-blob cleanup unlinks the shared pack.
		const updated = await vfs.updateFile(nodes[2]!.id, enc.encode('after'), { force: true });
		assert.equal(dec.decode(await vfs.readBytes(updated.id)), 'after');
		assert.equal(await vfs.opfs.exists(packPath), true, 'pack survives the edit');
		for (let i = 0; i < nodes.length; i++) {
			if (i === 2) continue;
			assert.equal(dec.decode(await vfs.readBytes(nodes[i]!.id)), `before-${i}`);
		}
		await vfs.db.delete();
	});

	it('keeps large members standalone so one file cannot pin a pack', async () => {
		const vfs = await mk('large');
		const folder = await vfs.mkdir(null, 'p');
		const big = new Uint8Array(33 * 1024 * 1024); // over half the 64MB cap
		const nodes = await vfs.writeFiles(
			[
				{ parentId: folder.id, name: 'big.bin', body: big },
				{ parentId: folder.id, name: 'small.txt', body: enc.encode('small') }
			],
			{ pack: true }
		);
		const bigRef = await vfs.db.blobRefs.get(nodes[0]!.blobId!);
		assert.equal(bigRef!.packOffset, undefined, 'large member is not packed');
		assert.ok(bigRef!.opfsPath.startsWith('blobs/'));
		assert.equal(dec.decode(await vfs.readBytes(nodes[1]!.id)), 'small');
		await vfs.db.delete();
	});

	it('does NOT pack unless the caller opts in', async () => {
		// The general filesystem must not create packs: members sharing storage
		// is a good trade only where deletion happens at pack granularity (a
		// project deleted whole), and a bad one where arbitrary files are
		// deleted in arbitrary order. Opt-in keeps that decision at the call
		// site rather than inferred from the data.
		const vfs = await mk('optin');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 12 }, (_, i) => ({
				parentId: folder.id,
				name: `o-${i}.txt`,
				body: enc.encode(`o${i}`)
			}))
		);
		const refs = await Promise.all(nodes.map((n) => vfs.db.blobRefs.get(n.blobId!)));
		assert.ok(
			refs.every((r) => r!.packOffset === undefined),
			'no packOffset without pack: true'
		);
		assert.ok(
			refs.every((r) => r!.opfsPath.startsWith('blobs/')),
			'every member owns its own file'
		);
		// And the bytes still round-trip on the unpacked path.
		assert.equal(dec.decode(await vfs.readBytes(nodes[5]!.id)), 'o5');
		await vfs.db.delete();
	});

	it('does not pack when the store cannot read ranges', async () => {
		// Inner-fs sessions run on the plain memory store; packing there would
		// be pointless and would make every read copy the whole pack.
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `packed-nogate-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 8 }, (_, i) => ({
				parentId: folder.id,
				name: `n-${i}.txt`,
				body: enc.encode(`n${i}`)
			})),
			{ pack: true }
		);
		const refs = await Promise.all(nodes.map((n) => vfs.db.blobRefs.get(n.blobId!)));
		assert.ok(
			refs.every((r) => r!.packOffset === undefined),
			'no packing without readRange'
		);
		assert.equal(dec.decode(await vfs.readBytes(nodes[0]!.id)), 'n0');
		await vfs.db.delete();
	});
});
