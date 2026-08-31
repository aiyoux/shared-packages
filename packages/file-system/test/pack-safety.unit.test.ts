import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	createVfs,
	createMemoryOpfs,
	resetSharedVfsForTests,
	crc32,
	packProject,
	exportProjectAsBundle,
	importProject
} from '../src/index.ts';
import * as vfsMod from '../src/vfs.ts';
import { expandBytes, packFiles } from '@shared-packages/compress';
import type { OpfsBlobStore } from '../src/opfs.ts';

const enc = new TextEncoder();

function rangeCapableStore(): OpfsBlobStore {
	const base = createMemoryOpfs();
	return {
		...base,
		writeFinal: (path, data) => base.writeFinal(path, data),
		async readRange(path, offset, length, contentType) {
			const all = await base.read(path);
			if (offset < 0 || length < 0 || offset + length > all.byteLength) {
				throw new Error(
					`Short pack read from ${path}: ${offset}+${length} past ${all.byteLength}`
				);
			}
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
		dbName: `pack-safety-${tag}-${Date.now()}-${Math.random()}`,
		opfs: rangeCapableStore(),
		requestPersist: false,
		graceMs: 1
	});
	await vfs.ready();
	return vfs;
}

describe('pack safety', () => {
	it('packed members round-trip with a checksum', async () => {
		const vfs = await mk('crc');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			[
				{ parentId: folder.id, name: 'a.txt', body: enc.encode('alpha') },
				{ parentId: folder.id, name: 'b.txt', body: enc.encode('bravo') }
			],
			{ pack: true }
		);
		const ref = await vfs.db.blobRefs.get(nodes[0]!.blobId!);
		assert.equal(ref!.crc32, crc32(enc.encode('alpha')));
		assert.equal(new TextDecoder().decode(await vfs.readBytes(nodes[0]!.id)), 'alpha');
		assert.equal(new TextDecoder().decode(await vfs.readBytes(nodes[1]!.id)), 'bravo');
		await vfs.db.delete();
	});

	it('a truncated pack fails loud instead of returning a neighbour', async () => {
		const vfs = await mk('short');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 8 }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.bin`,
				body: new Uint8Array(64).fill(i)
			})),
			{ pack: true }
		);
		const ref = await vfs.db.blobRefs.get(nodes[0]!.blobId!);
		const bytes = await vfs.opfs.read(ref!.opfsPath);
		await vfs.opfs.writeFinal(ref!.opfsPath, bytes.subarray(0, 20));
		await assert.rejects(() => vfs.readBytes(nodes[7]!.id), /Short pack|Checksum|past/);
		await vfs.db.delete();
	});

	it('failed packed write unlinks the pack file', async () => {
		resetSharedVfsForTests();
		const base = rangeCapableStore();
		let blows = 0;
		const opfs: OpfsBlobStore = {
			...base,
			async writeFinal(path, data) {
				if (path.startsWith('packs/') && blows++ === 0) {
					await base.writeFinal(path, data);
					throw new Error('quota');
				}
				return base.writeFinal(path, data);
			},
			async writeAtomic(path, data) {
				if (path.startsWith('packs/') && blows++ === 0) {
					await base.writeAtomic(path, data);
					throw new Error('quota');
				}
				return base.writeAtomic(path, data);
			}
		};
		const vfs = createVfs({
			dbName: `pack-cleanup-${Date.now()}`,
			opfs,
			requestPersist: false
		});
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'p');
		await assert.rejects(
			() =>
				vfs.writeFiles(
					[
						{ parentId: folder.id, name: 'a.bin', body: new Uint8Array(32).fill(1) },
						{ parentId: folder.id, name: 'b.bin', body: new Uint8Array(32).fill(2) }
					],
					{ pack: true }
				),
			/quota/
		);
		const packs = await vfs.opfs.listOrphans('packs');
		assert.deepEqual(packs, [], 'failed pack was unlinked');
		await vfs.db.delete();
	});

	it('emptyTrash does not delete a file restored before the delete txn', async () => {
		const vfs = await mk('trash-restore');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 6 }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.bin`,
				body: new Uint8Array(32).fill(i)
			})),
			{ pack: true }
		);
		await vfs.trash(nodes[0]!.id);
		await vfs.restore(nodes[0]!.id);
		const result = await vfs.emptyTrash();
		assert.equal(result.deleted, 0);
		assert.equal((await vfs.readBytes(nodes[0]!.id))[0], 0);
		await vfs.db.delete();
	});

	it('unpack skip does not unlink a dest another tab already swapped onto', async () => {
		const vfs = await mk('unpack-skip');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			[
				{ parentId: folder.id, name: 'a.bin', body: new Uint8Array(48).fill(9) },
				{ parentId: folder.id, name: 'b.bin', body: new Uint8Array(48).fill(8) }
			],
			{ pack: true }
		);
		const first = await vfs.unpackNodes([nodes[0]!.id, nodes[1]!.id]);
		assert.equal(first.movedFiles, 2);
		const dest = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;
		assert.ok(dest.startsWith('root/'));
		assert.equal(await vfs.opfs.exists(dest), true);
		const again = await vfs.unpackNodes([nodes[0]!.id, nodes[1]!.id]);
		assert.equal(again.movedFiles, 0);
		assert.equal(await vfs.opfs.exists(dest), true);
		assert.equal((await vfs.readBytes(nodes[0]!.id))[0], 9);
		await vfs.db.delete();
	});

	it('gc leaves a dest pack that only a packwrite lease names', async () => {
		const vfs = await mk('gc-dest');
		const folder = await vfs.mkdir(null, 'p');
		await vfs.writeFiles(
			[
				{ parentId: folder.id, name: 'a.bin', body: new Uint8Array(32).fill(1) },
				{ parentId: folder.id, name: 'b.bin', body: new Uint8Array(32).fill(2) }
			],
			{ pack: true }
		);
		const dest = `packs/pack_${crypto.randomUUID()}.bin`;
		await vfs.opfs.writeFinal(dest, new Uint8Array(64));
		await vfs.db.leases.put({
			key: `packwrite:${dest}`,
			owner: 'test',
			expiresAt: Date.now() + 60_000
		});
		await vfs.gc();
		assert.equal(await vfs.opfs.exists(dest), true, 'lease held the dest');
		await vfs.db.leases.delete(`packwrite:${dest}`);
		await vfs.gc();
		assert.equal(await vfs.opfs.exists(dest), false, 'expired dest is swept');
		await vfs.db.delete();
	});

	it('packProject does not absorb .git objects', async () => {
		const vfs = await mk('git-skip');
		const folder = await vfs.mkdir(null, 'repo');
		const git = await vfs.mkdir(folder.id, '.git');
		const objects = await vfs.mkdir(git.id, 'objects');
		await vfs.writeFile({
			parentId: objects.id,
			name: 'pack-me.bin',
			body: new Uint8Array(40).fill(7)
		});
		await vfs.writeFiles(
			[
				{ parentId: folder.id, name: 'a.txt', body: enc.encode('one-file') },
				{ parentId: folder.id, name: 'b.txt', body: enc.encode('two-file') }
			],
			{ pack: true }
		);
		await packProject(vfs, folder.id);
		const obj = (await vfs.list({ parentId: objects.id }))[0]!;
		const ref = await vfs.db.blobRefs.get(obj.blobId!);
		assert.equal(ref!.packOffset, undefined, '.git members stay standalone');
		await vfs.db.delete();
	});

	it('pending nodes past grace are swept as crash debris', async () => {
		const vfs = await mk('pending-debris');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			[
				{ parentId: folder.id, name: 'a.bin', body: new Uint8Array(16).fill(1) },
				{ parentId: folder.id, name: 'b.bin', body: new Uint8Array(16).fill(2) }
			],
			{ pack: true }
		);
		const ref = await vfs.db.blobRefs.get(nodes[0]!.blobId!);
		await vfs.db.blobRefs.put({ ...ref!, pending: true, createdAt: Date.now() - 10_000 });
		await vfs.gc();
		assert.equal(await vfs.get(nodes[0]!.id), undefined);
		await vfs.db.delete();
	});

	it('gc during compact after-write does not steal the dest pack', async () => {
		const vfs = await mk('crash-compact');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 80 }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.bin`,
				body: new Uint8Array(16 * 1024).fill(i & 0xff)
			})),
			{ pack: true }
		);
		for (const n of nodes.slice(0, 70)) await vfs.trash(n.id);
		await vfs.emptyTrash({ skipCompaction: true });
		vfsMod.compactCrash.hook = async (phase, newPath) => {
			if (phase !== 'after-write') return;
			await vfs.gc();
			assert.equal(await vfs.opfs.exists(newPath), true, 'gc must not unlink dest mid-compact');
		};
		try {
			await vfs.compactPacks([(await vfs.db.blobRefs.get(nodes[70]!.blobId!))!.opfsPath]);
		} finally {
			vfsMod.compactCrash.hook = null;
		}
		for (const n of nodes.slice(70)) {
			assert.equal((await vfs.readBytes(n.id)).byteLength, 16 * 1024);
		}
		await vfs.db.delete();
	});

	it('two unpackers: the loser does not delete the winner dest', async () => {
		resetSharedVfsForTests();
		let interleave: (() => Promise<void>) | null = null;
		const base = rangeCapableStore();
		const opfs: OpfsBlobStore = {
			...base,
			async writeAtomic(path, data) {
				const result = await base.writeAtomic!(path, data);
				if (path.startsWith('root/') && interleave) {
					const run = interleave;
					interleave = null;
					await run();
				}
				return result;
			}
		};
		const dbName = `unpack-tabs-${Date.now()}`;
		const a = createVfs({ dbName, opfs, requestPersist: false });
		const b = createVfs({ dbName, opfs, requestPersist: false });
		await a.ready();
		await b.ready();
		const folder = await a.mkdir(null, 'p');
		const nodes = await a.writeFiles(
			[
				{ parentId: folder.id, name: 'a.bin', body: new Uint8Array(64).fill(1) },
				{ parentId: folder.id, name: 'b.bin', body: new Uint8Array(64).fill(2) }
			],
			{ pack: true }
		);
		const ids = nodes.map((n) => n.id);
		interleave = async () => {
			await b.unpackNodes(ids).catch(() => {});
		};
		await a.unpackNodes(ids);
		assert.equal((await a.readBytes(nodes[0]!.id))[0], 1);
		assert.equal((await a.readBytes(nodes[1]!.id))[0], 2);
		await a.db.delete();
	});

	it('truncated .sprj import refuses rather than creating empty nodes', async () => {
		const vfs = await mk('sprj');
		const folder = await vfs.mkdir(null, 'Proj');
		await vfs.writeFiles(
			[
				{ parentId: folder.id, name: 'a.bin', body: new Uint8Array(32).fill(3) },
				{ parentId: folder.id, name: 'b.bin', body: new Uint8Array(32).fill(4) }
			],
			{ pack: true }
		);
		const { initProject } = await import('../src/projectMeta.ts');
		await initProject(vfs, folder.id, { name: 'Proj' });
		const bundle = await exportProjectAsBundle(vfs, folder.id);
		const members = await expandBytes('fflate', bundle.bytes, 'zip', bundle.name);
		const stripped = members.filter((m) => !m.name.startsWith('packs/'));
		const zipped = await packFiles(
			'fflate',
			stripped.map((m) => ({ name: m.name, data: m.data })),
			'zip'
		);
		await assert.rejects(
			() => importProject(vfs, null, zipped[0]!.data),
			/missing pack|refusing to import/i
		);
		await vfs.db.delete();
	});

	it('childByName hides pending reservations', async () => {
		let v: ReturnType<typeof createVfs> | undefined;
		let folderId: string | undefined;
		let saw: { listed: number; child?: string } | null = null;
		const base = rangeCapableStore();
		const opfs: OpfsBlobStore = {
			...base,
			async writeAtomic(path, data) {
				if (path.startsWith('packs/') && v && folderId && !saw) {
					const listed = await v.list({ parentId: folderId });
					const child = await v.childByName(folderId, 'a.bin');
					saw = { listed: listed.length, child: child?.id };
				}
				return base.writeAtomic!(path, data);
			}
		};
		resetSharedVfsForTests();
		v = createVfs({
			dbName: `pending-child-${Date.now()}`,
			opfs,
			requestPersist: false
		});
		await v.ready();
		const f = await v.mkdir(null, 'p');
		folderId = f.id;
		await v.writeFiles(
			[
				{ parentId: f.id, name: 'a.bin', body: new Uint8Array(16).fill(1) },
				{ parentId: f.id, name: 'b.bin', body: new Uint8Array(16).fill(2) }
			],
			{ pack: true }
		);
		assert.ok(saw);
		assert.equal(saw!.listed, 0);
		assert.equal(saw!.child, undefined);
		await v.db.delete();
	});

	it('gc re-checks blobRefs before unlinking a dest born after its snapshot', async () => {
		const vfs = await mk('gc-tocheck');
		const dest = `packs/pack_${crypto.randomUUID()}.bin`;
		const orig = vfs.opfs.listOrphans.bind(vfs.opfs);
		vfs.opfs.listOrphans = async (prefix: string) => {
			const found = await orig(prefix);
			if (prefix === 'packs') {
				await vfs.opfs.writeFinal(dest, new Uint8Array(8));
				await vfs.db.blobRefs.put({
					id: `late-${Date.now()}`,
					opfsPath: dest,
					byteLength: 8,
					createdAt: Date.now()
				});
				return [...found, dest];
			}
			return found;
		};
		await vfs.gc();
		assert.equal(await vfs.opfs.exists(dest), true, 'late-named dest must survive gc');
		await vfs.db.delete();
	});

	it('compact aborts without swap if the dest lease expired', async () => {
		const vfs = await mk('lease-expire');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 80 }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.bin`,
				body: new Uint8Array(16 * 1024).fill(i & 0xff)
			})),
			{ pack: true }
		);
		for (const n of nodes.slice(0, 70)) await vfs.trash(n.id);
		await vfs.emptyTrash({ skipCompaction: true });
		const oldPath = (await vfs.db.blobRefs.get(nodes[70]!.blobId!))!.opfsPath;
		vfsMod.compactCrash.hook = async (phase, newPath) => {
			if (phase !== 'after-write') return;
			const row = await vfs.db.leases.get(`packwrite:${newPath}`);
			if (row) await vfs.db.leases.put({ ...row, expiresAt: Date.now() - 1 });
		};
		try {
			await assert.rejects(() => vfs.compactPacks([oldPath]), /lease expired/);
		} finally {
			vfsMod.compactCrash.hook = null;
		}
		assert.equal(await vfs.opfs.exists(oldPath), true);
		assert.equal((await vfs.readBytes(nodes[70]!.id)).byteLength, 16 * 1024);
		await vfs.db.delete();
	});

	it('compact after-swap: survivors still read and dest is named', async () => {
		const vfs = await mk('after-swap');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 80 }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.bin`,
				body: new Uint8Array(16 * 1024).fill(i & 0xff)
			})),
			{ pack: true }
		);
		for (const n of nodes.slice(0, 70)) await vfs.trash(n.id);
		await vfs.emptyTrash({ skipCompaction: true });
		let destNamed = false;
		vfsMod.compactCrash.hook = async (phase, newPath) => {
			if (phase !== 'after-swap') return;
			await vfs.gc();
			destNamed = await vfs.opfs.exists(newPath);
		};
		try {
			await vfs.compactPacks([(await vfs.db.blobRefs.get(nodes[70]!.blobId!))!.opfsPath]);
		} finally {
			vfsMod.compactCrash.hook = null;
		}
		assert.equal(destNamed, true);
		assert.equal((await vfs.readBytes(nodes[70]!.id)).byteLength, 16 * 1024);
		await vfs.db.delete();
	});

	it('compact before-unlink: survivors still read', async () => {
		const vfs = await mk('before-unlink');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 80 }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.bin`,
				body: new Uint8Array(16 * 1024).fill(i & 0xff)
			})),
			{ pack: true }
		);
		for (const n of nodes.slice(0, 70)) await vfs.trash(n.id);
		await vfs.emptyTrash({ skipCompaction: true });
		vfsMod.compactCrash.hook = async (phase) => {
			if (phase !== 'before-unlink') return;
			await vfs.gc();
		};
		try {
			await vfs.compactPacks([(await vfs.db.blobRefs.get(nodes[70]!.blobId!))!.opfsPath]);
		} finally {
			vfsMod.compactCrash.hook = null;
		}
		for (const n of nodes.slice(70)) {
			assert.equal((await vfs.readBytes(n.id)).byteLength, 16 * 1024);
		}
		await vfs.db.delete();
	});

	it('compact refuses to swap a checksum-mismatched source', async () => {
		const vfs = await mk('crc-compact');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 80 }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.bin`,
				body: new Uint8Array(16 * 1024).fill(i & 0xff)
			})),
			{ pack: true }
		);
		for (const n of nodes.slice(0, 70)) await vfs.trash(n.id);
		await vfs.emptyTrash({ skipCompaction: true });
		const ref = await vfs.db.blobRefs.get(nodes[70]!.blobId!);
		const flipped = await vfs.opfs.read(ref!.opfsPath);
		const at = ref!.packOffset ?? 0;
		flipped[at] = flipped[at]! ^ 0xff;
		await vfs.opfs.writeFinal(ref!.opfsPath, flipped);
		await assert.rejects(() => vfs.compactPacks([ref!.opfsPath]), /Checksum mismatch/);
		assert.equal(await vfs.opfs.exists(ref!.opfsPath), true);
		await vfs.db.delete();
	});

	it('readPacked retries after compact moves the member', async () => {
		const vfs = await mk('gen-retry');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 80 }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.bin`,
				body: new Uint8Array(16 * 1024).fill(i & 0xff)
			})),
			{ pack: true }
		);
		for (const n of nodes.slice(0, 70)) await vfs.trash(n.id);
		await vfs.emptyTrash({ skipCompaction: true });
		const path = (await vfs.db.blobRefs.get(nodes[70]!.blobId!))!.opfsPath;
		const orig = vfs.opfs.readRange!.bind(vfs.opfs);
		let compacted = false;
		vfs.opfs.readRange = async (p, offset, length, ct) => {
			if (!compacted && p === path) {
				compacted = true;
				await vfs.compactPacks([path]);
			}
			return orig(p, offset, length, ct);
		};
		const bytes = await vfs.readBytes(nodes[70]!.id);
		assert.equal(bytes.byteLength, 16 * 1024);
		assert.equal(bytes[0], 70 & 0xff);
		await vfs.db.delete();
	});

	it('emptyTrash reports failedPacks and keeps members when compact is claimed', async () => {
		const vfs = await mk('failed-packs');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			Array.from({ length: 80 }, (_, i) => ({
				parentId: folder.id,
				name: `m-${i}.bin`,
				body: new Uint8Array(16 * 1024).fill(i & 0xff)
			})),
			{ pack: true }
		);
		const packPath = (await vfs.db.blobRefs.get(nodes[0]!.blobId!))!.opfsPath;
		await vfs.db.leases.put({
			key: `compact:${packPath}`,
			owner: 'other-tab',
			expiresAt: Date.now() + 60_000
		});
		for (const n of nodes.slice(0, 70)) await vfs.trash(n.id);
		const res = await vfs.emptyTrash();
		assert.ok(res.failedPacks.includes(packPath));
		assert.ok(await vfs.get(nodes[0]!.id), 'trashed member on a failed pack is not dropped');
		assert.equal((await vfs.readBytes(nodes[70]!.id)).byteLength, 16 * 1024);
		await vfs.db.delete();
	});

	it('withWebLock does not re-invoke fn after it throws', async () => {
		let runs = 0;
		const fn = async () => {
			runs += 1;
			throw new Error('callback failed');
		};
		const nav = {
			locks: {
				request: async (
					_name: string,
					_opts: unknown,
					cb: () => Promise<void>
				) => cb()
			}
		};
		const g = globalThis as { navigator: { locks?: unknown } };
		const prev = g.navigator.locks;
		g.navigator.locks = nav.locks;
		try {
			await assert.rejects(() => vfsMod.withWebLock('t', fn), /callback failed/);
			assert.equal(runs, 1);
		} finally {
			g.navigator.locks = prev;
		}
	});

	it('packed readBlob checksums members', async () => {
		const vfs = await mk('readblob-crc');
		const folder = await vfs.mkdir(null, 'p');
		const nodes = await vfs.writeFiles(
			[
				{ parentId: folder.id, name: 'a.bin', body: new Uint8Array(32).fill(3) },
				{ parentId: folder.id, name: 'b.bin', body: new Uint8Array(32).fill(4) }
			],
			{ pack: true }
		);
		const ref = await vfs.db.blobRefs.get(nodes[0]!.blobId!);
		const pack = await vfs.opfs.read(ref!.opfsPath);
		pack[ref!.packOffset!] = pack[ref!.packOffset!]! ^ 0xff;
		await vfs.opfs.writeFinal(ref!.opfsPath, pack);
		await assert.rejects(() => vfs.readBlob(nodes[0]!.id), /Checksum mismatch/);
		await vfs.db.delete();
	});
});
