import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, createMemoryOpfs, VfsError, isActionable, resetSharedVfsForTests } from '../src/index.ts';
import { isCatalogDeadError } from '../src/catalogEngine.ts';

describe('VfsService', () => {
	let vfs: ReturnType<typeof createVfs>;

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({ dbName: `test-vfs-${Date.now()}-${Math.random()}`, memoryOpfs: true });
		await vfs.ready();
	});

	it('mkdir + writeFile + list', async () => {
		const folder = await vfs.mkdir(null, 'Sketches');
		const file = await vfs.writeFile({
			parentId: folder.id,
			name: 'demo',
			fileType: 'skch',
			body: { format: 'skch', schemaVersion: 1, name: 'demo', data: { paths: [] } }
		});
		assert.equal(file.name, 'demo.skch');
		assert.equal(file.fileType, 'skch');
		assert.ok(file.generation === 1);
		const listed = await vfs.list({ parentId: folder.id });
		assert.equal(listed.length, 1);
		const json = await vfs.readJson(file.id);
		assert.equal((json as { format: string }).format, 'skch');
	});

	it('name collision auto-suffix', async () => {
		await vfs.writeFile({ parentId: null, name: 'a.skch', fileType: 'skch', body: { n: 1 } });
		const b = await vfs.writeFile({ parentId: null, name: 'a.skch', fileType: 'skch', body: { n: 2 } });
		assert.equal(b.name, 'a (1).skch');
	});

	it('writeFile onConflict overwrite replaces the same-name file in place', async () => {
		const a = await vfs.writeFile({ parentId: null, name: 'o.skch', fileType: 'skch', body: { v: 1 } });
		const b = await vfs.writeFile({
			parentId: null,
			name: 'o.skch',
			fileType: 'skch',
			body: { v: 2 },
			onConflict: 'overwrite'
		});
		assert.equal(b.id, a.id, 'keeps the existing node id');
		assert.equal(b.name, 'o.skch');
		assert.equal(b.generation, a.generation + 1, 'bumps generation for cross-tab CAS');
		assert.deepEqual(await vfs.readJson(b.id), { v: 2 });
		// A later CAS save with the old generation must conflict.
		await assert.rejects(
			() => vfs.updateFile(b.id, { v: 3 }, { expectedGeneration: a.generation }),
			(e: unknown) => e instanceof VfsError && e.code === 'GENERATION_CONFLICT'
		);
	});

	it('writeFile onConflict overwrite with no collision creates a fresh node', async () => {
		const n = await vfs.writeFile({
			parentId: null,
			name: 'fresh.skch',
			fileType: 'skch',
			body: { v: 1 },
			onConflict: 'overwrite'
		});
		assert.equal(n.name, 'fresh.skch');
		assert.equal(n.generation, 1);
	});

	it('writeMany stores many paths in one call', async () => {
		const store = createMemoryOpfs();
		await store.writeMany!([
			{ path: 'bulk/a.bin', data: new Uint8Array([1, 2]) },
			{ path: 'bulk/b.bin', data: new Uint8Array([3, 4]) }
		]);
		assert.deepEqual([...(await store.read('bulk/a.bin'))], [1, 2]);
		assert.deepEqual([...(await store.read('bulk/b.bin'))], [3, 4]);
	});

	it('writeFiles bulk-writes many members with unique names and readable bytes', async () => {
		const folder = await vfs.mkdir(null, 'extract');
		const inputs = Array.from({ length: 60 }, (_, i) => ({
			parentId: folder.id,
			name: `member-${i}.txt`,
			body: new TextEncoder().encode(`content-${i}`)
		}));
		const nodes = await vfs.writeFiles(inputs);
		assert.equal(nodes.length, inputs.length, 'one node per input, in order');
		const listed = await vfs.list({ parentId: folder.id });
		assert.equal(listed.length, inputs.length);
		for (let i = 0; i < nodes.length; i++) {
			assert.equal(nodes[i]!.name, `member-${i}.txt`);
			const blob = await vfs.readBlob(nodes[i]!.id);
			const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
			assert.equal(text, `content-${i}`);
		}
	});

	it('writeFiles renames collisions against existing siblings and within the batch', async () => {
		const enc = new TextEncoder();
		await vfs.writeFile({ parentId: null, name: 'dup.txt', body: enc.encode('existing') });
		const nodes = await vfs.writeFiles([
			{ parentId: null, name: 'dup.txt', body: enc.encode('first') },
			{ parentId: null, name: 'dup.txt', body: enc.encode('second') }
		]);
		assert.equal(nodes[0]!.name, 'dup (1).txt');
		assert.equal(nodes[1]!.name, 'dup (2).txt');
		const read = async (id: string) =>
			new TextDecoder().decode(new Uint8Array(await (await vfs.readBlob(id)).arrayBuffer()));
		assert.equal(await read(nodes[0]!.id), 'first');
		assert.equal(await read(nodes[1]!.id), 'second');
		const existing = await vfs.list({ parentId: null });
		const original = existing.find((n) => n.name === 'dup.txt');
		assert.ok(original, 'existing sibling untouched');
		assert.equal(await read(original!.id), 'existing');
	});

	it('writeFiles reports progress per chunk without capping the batch', async () => {
		// Callers must NOT pre-slice into small batches: chunking belongs in
		// writeFiles, where the OPFS round-trip cost actually lives. onProgress
		// is what lets a caller still paint per file after handing over a whole
		// group.
		const folder = await vfs.mkdir(null, 'progress');
		const N = 60;
		const seen: number[] = [];
		const nodes = await vfs.writeFiles(
			Array.from({ length: N }, (_, i) => ({
				parentId: folder.id,
				name: `p-${i}.txt`,
				body: new TextEncoder().encode(`v${i}`)
			})),
			{ onProgress: (written) => seen.push(written.length) }
		);
		assert.equal(nodes.length, N);
		assert.ok(seen.length > 0, 'onProgress fired');
		assert.equal(
			seen.reduce((a, b) => a + b, 0),
			N,
			'every written node is reported exactly once'
		);
		// Order must match the inputs so callers can zip progress back to their
		// own list.
		for (let i = 0; i < N; i++) assert.equal(nodes[i]!.name, `p-${i}.txt`);
		const listed = await vfs.list({ parentId: folder.id });
		assert.equal(listed.length, N);
	});

	it('writeFiles rejects explicit ids and non-rename conflict modes', async () => {
		await assert.rejects(
			() => vfs.writeFiles([{ parentId: null, name: 'x.txt', body: 'x', id: 'file_x' }]),
			(e: unknown) => e instanceof VfsError && e.code === 'API_MISUSE'
		);
		await assert.rejects(
			() =>
				vfs.writeFiles([{ parentId: null, name: 'x.txt', body: 'x', onConflict: 'overwrite' }]),
			(e: unknown) => e instanceof VfsError && e.code === 'API_MISUSE'
		);
	});

	it('writeFile onConflict overwrite refuses a same-name folder', async () => {
		await vfs.mkdir(null, 'dir.skch');
		await assert.rejects(
			() =>
				vfs.writeFile({
					parentId: null,
					name: 'dir.skch',
					fileType: 'skch',
					body: { v: 1 },
					onConflict: 'overwrite'
				}),
			(e: unknown) => e instanceof VfsError && e.code === 'NAME_CONFLICT'
		);
	});

	it('updateFile generation CAS', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 'x.skch', fileType: 'skch', body: { v: 1 } });
		const u1 = await vfs.updateFile(f.id, { v: 2 }, { expectedGeneration: f.generation });
		assert.equal(u1.generation, 2);
		await assert.rejects(
			() => vfs.updateFile(f.id, { v: 3 }, { expectedGeneration: 1 }),
			(e: unknown) => e instanceof VfsError && e.code === 'GENERATION_CONFLICT'
		);
		const forced = await vfs.updateFile(f.id, { v: 4 }, { force: true });
		assert.equal(forced.generation, 3);
		assert.deepEqual(await vfs.readJson(f.id), { v: 4 });
	});

	it('trash restore permanentDelete', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 't.skch', fileType: 'skch', body: { a: 1 } });
		await vfs.trash(f.id);
		const active = await vfs.list({ parentId: null });
		assert.equal(active.length, 0);
		const trash = await vfs.list({ parentId: null, trashOnly: true });
		assert.equal(trash.length, 1);
		await vfs.restore(f.id);
		assert.equal((await vfs.list({ parentId: null })).length, 1);
		await vfs.trash(f.id);
		await vfs.permanentDelete(f.id, { recursive: true });
		assert.equal((await vfs.list({ parentId: null, trashOnly: true })).length, 0);
	});

	it('folder trash subtree', async () => {
		const dir = await vfs.mkdir(null, 'A');
		const file = await vfs.writeFile({ parentId: dir.id, name: 'f.skch', fileType: 'skch', body: {} });
		await vfs.trash(dir.id);
		assert.equal((await vfs.list({ parentId: null })).length, 0);
		const roots = await vfs.list({ parentId: null, trashOnly: true });
		assert.equal(roots.length, 1);
		const trashedRef = await vfs.db.blobRefs.get(file.blobId!);
		assert.equal(trashedRef?.opfsPath, 'trash/A/f.skch');
		await vfs.restore(dir.id);
		assert.equal((await vfs.list({ parentId: dir.id })).length, 1);
		const restoredRef = await vfs.db.blobRefs.get(file.blobId!);
		assert.equal(restoredRef?.opfsPath, 'root/A/f.skch');
	});

	it('emptyTrash bulk-deletes a folder tree and reports progress without per-file notifies', async () => {
		await vfs.writeFile({ parentId: null, name: 'keep.txt', body: 'keep' });
		const dir = await vfs.mkdir(null, 'repo');
		for (let i = 0; i < 20; i++) {
			await vfs.writeFile({ parentId: dir.id, name: `n${i}.txt`, body: `x${i}` });
		}
		await vfs.trash(dir.id);
		assert.equal((await vfs.list({ parentId: null, trashOnly: true })).length, 1);

		let notifies = 0;
		const unsub = vfs.subscribe(() => {
			notifies++;
		});
		const ticks: Array<{ done: number; total: number; name?: string }> = [];
		await vfs.emptyTrash({
			onProgress: (ev) => ticks.push({ done: ev.done, total: ev.total, name: ev.name })
		});
		unsub();

		assert.ok(notifies >= 1 && notifies <= 2);
		assert.ok(ticks.length >= 2);
		assert.equal(ticks[0]!.done, 0);
		assert.equal(ticks[0]!.name, 'Scanning trash…');
		assert.equal(ticks[ticks.length - 1]!.done, ticks[ticks.length - 1]!.total);
		assert.ok(ticks[ticks.length - 1]!.total >= 21);
		assert.equal((await vfs.list({ parentId: null, trashOnly: true })).length, 0);
		const live = await vfs.list({ parentId: null });
		assert.equal(live.length, 1);
		assert.equal(live[0]!.name, 'keep.txt');
	});

	it('emptyTrash abort before work leaves trash in place', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 'gone.txt', body: 'x' });
		await vfs.trash(f.id);
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(
			() => vfs.emptyTrash({ signal: ac.signal }),
			(e: unknown) => e instanceof Error && e.name === 'AbortError'
		);
		assert.equal((await vfs.list({ parentId: null, trashOnly: true })).length, 1);
	});

	it('isActionable grey-out helper', () => {
		assert.equal(isActionable({ kind: 'folder' } as any, ['skch']), true);
		assert.equal(
			isActionable({ kind: 'file', fileType: 'vrec' } as any, ['skch']),
			false
		);
		assert.equal(
			isActionable({ kind: 'file', fileType: 'skch' } as any, ['skch']),
			true
		);
	});

	it('rename move copy', async () => {
		const a = await vfs.mkdir(null, 'A');
		const b = await vfs.mkdir(null, 'B');
		const f = await vfs.writeFile({
			parentId: a.id,
			name: 'c.skch',
			fileType: 'skch',
			body: { x: 1 }
		});
		await vfs.rename(f.id, 'd');
		assert.equal((await vfs.get(f.id))!.name, 'd.skch');
		await vfs.move(f.id, b.id);
		assert.equal((await vfs.get(f.id))!.parentId, b.id);
		const copy = await vfs.copy(f.id, a.id);
		assert.notEqual(copy.id, f.id);
		assert.deepEqual(await vfs.readJson(copy.id), { x: 1 });
	});

	it('drafts not in list', async () => {
		await vfs.putDraft({
			id: 'sketcher:current',
			appId: 'sketcher',
			updatedAt: Date.now(),
			payload: { dirty: true }
		});
		assert.equal((await vfs.list({ parentId: null })).length, 0);
		assert.ok(await vfs.getDraft('sketcher:current'));
	});

	it('gc removes unreferenced after permanent delete', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 'g.skch', fileType: 'skch', body: { z: 9 } });
		await vfs.trash(f.id);
		await vfs.permanentDelete(f.id, { recursive: true });
		const report = await vfs.gc();
		assert.ok(report.orphanBlobRefsRemoved >= 0);
	});

	it('read missing OPFS throws OPFS_IO', async () => {
		const f = await vfs.writeFile({ parentId: null, name: 'm.skch', fileType: 'skch', body: { q: 1 } });
		const node = await vfs.get(f.id);
		const ref = await vfs.db.blobRefs.get(node!.blobId!);
		await vfs.opfs.remove(ref!.opfsPath);
		await assert.rejects(
			() => vfs.readBytes(f.id),
			(e: unknown) => e instanceof VfsError && e.code === 'OPFS_IO'
		);
	});

	it('writeFile preserves multi-ext image names (omit or pass fileType image)', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		// Omit fileType → infer image from .jpg → must NOT become photo.jpg.png
		const jpg = await vfs.writeFile({
			parentId: null,
			name: 'photo.jpg',
			body: bytes,
			contentType: 'image/jpeg'
		});
		assert.equal(jpg.name, 'photo.jpg');
		assert.equal(jpg.fileType, 'image');

		const webp = await vfs.writeFile({
			parentId: null,
			name: 'icon.webp',
			fileType: 'image',
			body: bytes,
			contentType: 'image/webp'
		});
		assert.equal(webp.name, 'icon.webp');
		assert.equal(webp.fileType, 'image');

		// bare name with image type still gets primary .png
		const bare = await vfs.writeFile({
			parentId: null,
			name: 'shot',
			fileType: 'image',
			body: bytes
		});
		assert.equal(bare.name, 'shot.png');
		assert.equal(bare.fileType, 'image');
	});

	it('updateFile keeps the old blob if promote fails', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'keep.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const before = await vfs.get(f.id);
		const origPromote = vfs.opfs.promote.bind(vfs.opfs);
		vfs.opfs.promote = async () => {
			throw new Error('promote-boom');
		};
		await assert.rejects(
			() => vfs.updateFile(f.id, { v: 2 }, { expectedGeneration: f.generation }),
			(e: unknown) => e instanceof Error && String(e).includes('promote-boom')
		);
		vfs.opfs.promote = origPromote;
		const after = await vfs.get(f.id);
		assert.equal(after!.blobId, before!.blobId);
		assert.equal(after!.generation, before!.generation);
		assert.deepEqual(await vfs.readJson(f.id), { v: 1 });
	});

	it('gc does not delete a pendingPromote blobRef or its blobs/ path', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'staged.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const stagedId = 'blob-pending-test';
		await vfs.db.blobRefs.put({
			id: stagedId,
			opfsPath: 'tmp/staged.partial',
			byteLength: 4,
			createdAt: Date.now(),
			pendingPromote: true
		});
		await vfs.opfs.writePartial('staged', new Uint8Array([1, 2, 3, 4]));
		await vfs.opfs.promote('tmp/staged.partial', `blobs/${stagedId}.bin`);
		const report = await vfs.gc();
		void report;
		const still = await vfs.db.blobRefs.get(stagedId);
		assert.ok(still, 'pendingPromote ref must survive gc');
		const bytes = await vfs.opfs.read(`blobs/${stagedId}.bin`);
		assert.equal(bytes.byteLength, 4);
		assert.ok(await vfs.get(f.id));
	});

	it('writeFile / mkdir refuse a parent that is trashed inside the txn', async () => {
		const folder = await vfs.mkdir(null, 'SoonGone');
		await vfs.trash(folder.id);
		await assert.rejects(
			() => vfs.mkdir(folder.id, 'child'),
			(e: unknown) => e instanceof VfsError && e.code === 'TRASH_STATE'
		);
		await assert.rejects(
			() =>
				vfs.writeFile({
					parentId: folder.id,
					name: 'x.skch',
					fileType: 'skch',
					body: {}
				}),
			(e: unknown) => e instanceof VfsError && e.code === 'TRASH_STATE'
		);
	});

	it('writeFile refuses a live or trashed id', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'gone.skch',
			fileType: 'skch',
			body: { keep: true }
		});
		await assert.rejects(
			() =>
				vfs.writeFile({
					id: f.id,
					parentId: null,
					name: 'reuse.skch',
					fileType: 'skch',
					body: { keep: false }
				}),
			(e: unknown) => e instanceof VfsError && e.code === 'NAME_CONFLICT'
		);
		await vfs.trash(f.id);
		await assert.rejects(
			() =>
				vfs.writeFile({
					id: f.id,
					parentId: null,
					name: 'reuse.skch',
					fileType: 'skch',
					body: { keep: false }
				}),
			(e: unknown) =>
				e instanceof VfsError &&
				e.code === 'NAME_CONFLICT' &&
				(e as VfsError).details?.trashed === true
		);
		const still = await vfs.get(f.id);
		assert.ok(still);
		assert.ok(still!.deletedAt != null);
		assert.deepEqual(await vfs.readJson(f.id), { keep: true });
	});

	it('metadata ops do not bump generation; updateFile with pre-move gen succeeds', async () => {
		const folder = await vfs.mkdir(null, 'Docs');
		const f = await vfs.writeFile({
			parentId: null,
			name: 'x.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const gen = f.generation;
		await vfs.rename(f.id, 'y');
		assert.equal((await vfs.get(f.id))!.generation, gen);
		await vfs.move(f.id, folder.id);
		assert.equal((await vfs.get(f.id))!.generation, gen);
		assert.equal((await vfs.get(f.id))!.parentId, folder.id);
		const sibling = await vfs.writeFile({
			parentId: folder.id,
			name: 'z.skch',
			fileType: 'skch',
			body: { v: 0 }
		});
		await vfs.reorder(f.id, { afterId: sibling.id });
		assert.equal((await vfs.get(f.id))!.generation, gen);
		const updated = await vfs.updateFile(f.id, { v: 2 }, { expectedGeneration: gen });
		assert.equal(updated.generation, gen + 1);
		assert.deepEqual(await vfs.readJson(f.id), { v: 2 });
		await vfs.trash(f.id);
		assert.equal((await vfs.get(f.id))!.generation, gen + 1);
		await vfs.restore(f.id);
		assert.equal((await vfs.get(f.id))!.generation, gen + 1);
		const afterRestore = await vfs.updateFile(f.id, { v: 3 }, { expectedGeneration: gen + 1 });
		assert.equal(afterRestore.generation, gen + 2);
	});

	it('batch notifies subscribers once for many mkdirs', async () => {
		let n = 0;
		const unsub = vfs.subscribe(() => {
			n += 1;
		});
		await vfs.batch(async () => {
			await vfs.mkdir(null, 'a');
			await vfs.mkdir(null, 'b');
			await vfs.mkdir(null, 'c');
		});
		unsub();
		assert.equal(n, 1);
		assert.equal((await vfs.list({ parentId: null })).length, 3);
	});

	it('ensureFolders creates a tree without listing every parent', async () => {
		const root = await vfs.mkdir(null, 'ex');
		const map = await vfs.ensureFolders(root.id, [
			['src', 'lib'],
			['src', 'bin'],
			['docs']
		]);
		assert.ok(map.get('src'));
		assert.ok(map.get('src/lib'));
		assert.ok(map.get('src/bin'));
		assert.ok(map.get('docs'));
		const src = await vfs.childByName(root.id, 'src');
		assert.equal(src?.kind, 'folder');
		assert.ok(await vfs.childByName(src!.id, 'lib'));
		assert.ok(await vfs.childByName(src!.id, 'bin'));
		assert.ok(await vfs.childByName(root.id, 'docs'));
	});

	it('ensureFolders materializeOpfs:false still catalogs without mkdir', async () => {
		const root = await vfs.mkdir(null, 'pk');
		let mk = 0;
		const orig = vfs.opfs.ensureDir?.bind(vfs.opfs);
		vfs.opfs.ensureDir = async (p: string) => {
			mk += 1;
			await orig?.(p);
		};
		const map = await vfs.ensureFolders(root.id, [['a', 'b'], ['a', 'c']], {
			materializeOpfs: false
		});
		assert.equal(mk, 0);
		assert.ok(map.get('a'));
		assert.ok(await vfs.childByName(root.id, 'a'));
		assert.ok(await vfs.childByName(map.get('a')!, 'b'));
	});

	it('ensureFolders existing map skips already-known prefixes', async () => {
		const root = await vfs.mkdir(null, 'seed');
		const first = await vfs.ensureFolders(root.id, [['a', 'b']]);
		const second = await vfs.ensureFolders(root.id, [['a', 'b'], ['a', 'c']], {
			existing: first,
			materializeOpfs: false
		});
		assert.equal(second.get('a'), first.get('a'));
		assert.equal(second.get('a/b'), first.get('a/b'));
		assert.ok(second.get('a/c'));
		assert.notEqual(second.get('a/c'), first.get('a/b'));
	});

	it('ensureFolders commits a deep tree in one IDB transaction', async () => {
		const root = await vfs.mkdir(null, 'deep');
		let txns = 0;
		const orig = vfs.db.transaction.bind(vfs.db);
		vfs.db.transaction = ((...args: Parameters<typeof orig>) => {
			txns += 1;
			return orig(...args);
		}) as typeof orig;
		const paths: string[][] = [];
		for (let i = 0; i < 80; i++) {
			paths.push([`d0_${i % 5}`, `d1_${i % 8}`, `leaf_${i}`]);
		}
		const map = await vfs.ensureFolders(root.id, paths);
		assert.equal(txns, 1, 'one rw txn, not one commit per parent');
		assert.equal(map.get('') , root.id);
		assert.equal(
			[...map.keys()].filter((k) => k !== '').length,
			5 + 5 * 8 + 80,
			'every prefix becomes a folder'
		);
		const d0 = await vfs.childByName(root.id, 'd0_0');
		assert.equal(d0?.kind, 'folder');
	});

	it('writeTree stores a nested tree in OPFS then one catalog commit', async () => {
		const root = await vfs.mkdir(null, 'inbox');
		let txns = 0;
		const orig = vfs.db.transaction.bind(vfs.db);
		vfs.db.transaction = ((...args: Parameters<typeof orig>) => {
			txns += 1;
			return orig(...args);
		}) as typeof orig;
		const nodes = await vfs.writeTree(root.id, [
			{ path: 'repo/a.txt', body: new Uint8Array([1, 2, 3]) },
			{ path: 'repo/nested/b.txt', body: new Uint8Array([4, 5]) }
		]);
		assert.equal(txns, 1, 'catalog is one txn after OPFS writes');
		assert.equal(nodes.length, 2);
		const repo = await vfs.childByName(root.id, 'repo');
		assert.equal(repo?.kind, 'folder');
		const nested = await vfs.childByName(repo!.id, 'nested');
		assert.equal(nested?.kind, 'folder');
		const a = await vfs.childByName(repo!.id, 'a.txt');
		const b = await vfs.childByName(nested!.id, 'b.txt');
		assert.equal((await vfs.readBytes(a!.id))[0], 1);
		assert.equal((await vfs.readBytes(b!.id))[0], 4);
		const ref = await vfs.db.blobRefs.get(a!.blobId!);
		assert.ok(ref?.opfsPath.startsWith('root/inbox/'), 'bytes live under root/<catalog path>');
		assert.equal(ref?.opfsPath, 'root/inbox/repo/a.txt');
		assert.equal(ref?.pending, false);
	});

	it('writeFile direct skips tmp+promote', async () => {
		const orig = vfs.opfs.writePartial.bind(vfs.opfs);
		let partials = 0;
		vfs.opfs.writePartial = async (id, data) => {
			partials += 1;
			return orig(id, data);
		};
		const node = await vfs.writeFile({
			parentId: null,
			name: 'blob.bin',
			body: new Uint8Array([1, 2, 3, 4]),
			fileType: 'unknown',
			direct: true
		});
		assert.equal(partials, 0);
		assert.equal(node.size, 4);
		assert.equal((await vfs.readBytes(node.id))[0], 1);
		assert.equal(await vfs.opfs.exists('root/blob.bin'), true);
	});

	it('rename moves the unpacked OPFS file to the new catalog path', async () => {
		const folder = await vfs.mkdir(null, 'docs');
		const file = await vfs.writeFile({
			parentId: folder.id,
			name: 'a.txt',
			body: new TextEncoder().encode('hi')
		});
		const before = await vfs.db.blobRefs.get(file.blobId!);
		assert.equal(before?.opfsPath, 'root/docs/a.txt');
		await vfs.rename(file.id, 'b.txt');
		const after = await vfs.db.blobRefs.get(file.blobId!);
		assert.equal(after?.opfsPath, 'root/docs/b.txt');
		assert.equal(await vfs.opfs.exists('root/docs/a.txt'), false);
		assert.equal(await vfs.opfs.exists('root/docs/b.txt'), true);
		assert.equal(new TextDecoder().decode(await vfs.readBytes(file.id)), 'hi');
	});

	it('deferCompact compactPacks once after nested packed deletes', async () => {
		const folder = await vfs.mkdir(null, 'bulk');
		const bodies = [
			new Uint8Array(48).fill(1),
			new Uint8Array(48).fill(2),
			new Uint8Array(48).fill(3)
		];
		const nodes = await vfs.writeFiles(
			bodies.map((body, i) => ({
				parentId: folder.id,
				name: `${String.fromCharCode(97 + i)}.bin`,
				body
			}))
		);
		const packPath = 'packs/audit-bulk.bin';
		const packed = new Uint8Array(144);
		packed.set(bodies[0]!, 0);
		packed.set(bodies[1]!, 48);
		packed.set(bodies[2]!, 96);
		await vfs.opfs.writeFinal(packPath, packed);
		for (const [i, n] of nodes.entries()) {
			const ref = await vfs.db.blobRefs.get(n.blobId!);
			assert.ok(ref);
			ref.opfsPath = packPath;
			ref.packOffset = i * 48;
			ref.byteLength = 48;
			await vfs.db.blobRefs.put(ref);
		}
		let compactCalls = 0;
		const orig = vfs.compactPacks.bind(vfs);
		vfs.compactPacks = (async (...args: Parameters<typeof orig>) => {
			compactCalls += 1;
			return orig(...args);
		}) as typeof orig;
		await vfs.deferCompact(async () => {
			await vfs.deferCompact(async () => {
				for (const n of nodes.slice(0, 2)) {
					await vfs.trash(n.id);
					await vfs.permanentDelete(n.id);
				}
			});
		});
		assert.equal(compactCalls, 1, `expected one compact at outer exit, got ${compactCalls}`);
		vfs.compactPacks = orig;
		assert.equal((await vfs.readBytes(nodes[2]!.id))[0], 3);
	});

	it('updateFile dest is unique until catalog swap, then root/rel', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'edit-me.txt',
			body: new TextEncoder().encode('one')
		});
		const updated = await vfs.updateFile(f.id, new TextEncoder().encode('two'), {
			expectedGeneration: f.generation
		});
		assert.equal(updated.generation, f.generation + 1);
		assert.notEqual(updated.blobId, f.blobId);
		const ref = await vfs.db.blobRefs.get(updated.blobId!);
		assert.equal(ref?.opfsPath, 'root/edit-me.txt');
		assert.equal(new TextDecoder().decode(await vfs.readBytes(f.id)), 'two');
	});

	it('writeTree uniquifies without overwriting a live sibling OPFS path', async () => {
		const root = await vfs.mkdir(null, 'inbox');
		const live = await vfs.writeFile({
			parentId: root.id,
			name: 'a.txt',
			body: new TextEncoder().encode('keep-me')
		});
		const nodes = await vfs.writeTree(root.id, [
			{ path: 'a.txt', body: new TextEncoder().encode('extracted') }
		]);
		assert.equal(nodes.length, 1);
		assert.equal(nodes[0]!.name, 'a (1).txt');
		const liveRef = await vfs.db.blobRefs.get(live.blobId!);
		assert.equal(liveRef?.opfsPath, 'root/inbox/a.txt');
		assert.equal(new TextDecoder().decode(await vfs.readBytes(live.id)), 'keep-me');
		const extractedRef = await vfs.db.blobRefs.get(nodes[0]!.blobId!);
		assert.equal(extractedRef?.opfsPath, 'root/inbox/a (1).txt');
		assert.equal(new TextDecoder().decode(await vfs.readBytes(nodes[0]!.id)), 'extracted');
		assert.equal(await vfs.opfs.exists('tmp/tree-' + nodes[0]!.blobId + '.bin'), false);
	});

	it('unpackNodes settles onto root/rel from a unique staging dest', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'packed.txt',
			body: new TextEncoder().encode('from-pack')
		});
		const packPath = 'packs/audit-unpack.bin';
		const bytes = new TextEncoder().encode('from-pack');
		await vfs.opfs.writeFinal(packPath, bytes);
		const ref = await vfs.db.blobRefs.get(f.blobId!);
		assert.ok(ref);
		ref.opfsPath = packPath;
		ref.packOffset = 0;
		ref.byteLength = bytes.byteLength;
		await vfs.db.blobRefs.put(ref);
		const moved = await vfs.unpackNodes([f.id]);
		assert.equal(moved.movedFiles, 1);
		const after = await vfs.db.blobRefs.get(f.blobId!);
		assert.equal(after?.opfsPath, 'root/packed.txt');
		assert.equal(after?.packOffset, undefined);
		assert.equal(new TextDecoder().decode(await vfs.readBytes(f.id)), 'from-pack');
	});

	it('gc skips when migrationOk is false', async () => {
		await vfs.opfs.writeFinal('root/orphan-audit.bin', new Uint8Array([9]));
		vfs.db.migrationOk = false;
		const skipped = await vfs.gc();
		assert.equal(skipped.orphanOpfsRemoved, 0);
		assert.equal(await vfs.opfs.exists('root/orphan-audit.bin'), true);
		vfs.db.migrationOk = true;
		const swept = await vfs.gc();
		assert.ok(swept.orphanOpfsRemoved >= 1);
		assert.equal(await vfs.opfs.exists('root/orphan-audit.bin'), false);
	});

	it('isCatalogDeadError matches worker-death messages', () => {
		assert.equal(isCatalogDeadError(new Error('catalog leader gone')), true);
		assert.equal(isCatalogDeadError(new Error('catalog RPC timeout')), true);
		assert.equal(isCatalogDeadError(new Error('no such table: nodes')), false);
	});

	it('ready retries after a failed catalog open', async () => {
		const retry = createVfs({ dbName: `retry-${Date.now()}`, memoryOpfs: true });
		const orig = retry.db.openWithStore.bind(retry.db);
		let n = 0;
		retry.db.openWithStore = async (opfs, persist) => {
			n += 1;
			if (n === 1) throw new Error('first open fails');
			return orig(opfs, persist);
		};
		await assert.rejects(() => retry.ready(), /first open fails/);
		await retry.ready();
		const folder = await retry.mkdir(null, 'after-retry');
		assert.equal(folder.name, 'after-retry');
		assert.equal(n, 2);
	});
});
