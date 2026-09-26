import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, createMemoryOpfs, resetSharedVfsForTests } from '../src/index.ts';
import type { OpfsBlobStore } from '../src/opfs.ts';
import type { VfsService } from '../src/vfs.ts';

/**
 * GC against a write whose bytes have landed but whose catalog row has not.
 *
 * GC's rule for a file under root/ or tmp/ is "no committed row names it, so
 * it is an orphan". Every writer therefore has a window where that rule is
 * false: the file is in place and the row is still in an open transaction.
 * The writer has to say so with a lease GC can see — the age of the file is
 * no answer, because a frozen tab can sit in that window for any length of
 * time. `graceMs: -1` below is that frozen tab: every file is already older
 * than the grace window (GC spares `age <= graceMs`, and a file written this
 * millisecond has age 0), so nothing is spared by age.
 */

/**
 * Leases are judged by Web Locks in a browser. Without them the row's clock
 * decides, and a negative grace would expire every lease at birth — so give the
 * process the minimum lock manager `leaseOwner.ts` needs: held names, a query,
 * and `ifAvailable`. Installed before anything touches a lease; nothing here
 * dies, so nothing is ever released.
 */
const held = new Set<string>();
const locks = {
	request(name: string, opts: { ifAvailable?: boolean }, cb: (lock: unknown) => unknown) {
		if (held.has(name)) {
			return opts?.ifAvailable ? Promise.resolve(cb(null)) : new Promise(() => {});
		}
		held.add(name);
		return Promise.resolve(cb({ name })).finally(() => held.delete(name));
	},
	async query() {
		return { held: [...held].map((name) => ({ name })) };
	}
};
const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
if (nav) Object.defineProperty(nav, 'locks', { value: locks, configurable: true, writable: true });
else (globalThis as unknown as { navigator: unknown }).navigator = { locks };

type Hook = (vfs: VfsService, op: string, path: string) => Promise<void>;

function hookedStore(hook: Hook, getVfs: () => VfsService): OpfsBlobStore {
	const base = createMemoryOpfs();
	return {
		...base,
		async writeFinal(path, data, opts) {
			const r = await base.writeFinal(path, data as never, opts as never);
			await hook(getVfs(), 'writeFinal', path);
			return r;
		},
		async writeMany(entries, opts) {
			await base.writeMany!(entries, opts);
			for (const e of entries) await hook(getVfs(), 'writeFinal', e.path);
		},
		async move(from, to) {
			await base.move(from, to);
			await hook(getVfs(), 'move', to);
		},
		async movePrefix(from, to) {
			await base.movePrefix(from, to);
			await hook(getVfs(), 'movePrefix', to);
		}
	};
}

function vfsWith(tag: string, hook: Hook): VfsService {
	resetSharedVfsForTests();
	let vfs!: VfsService;
	const opfs = hookedStore(hook, () => vfs);
	vfs = createVfs({
		dbName: `gc-gaps-${tag}-${Date.now()}-${Math.random()}`,
		opfs,
		graceMs: -1
	});
	return vfs;
}

const bytes = (i: number) => new Uint8Array([i, 1, 2, 3, 0xee]);

describe('gc vs a write between its bytes and its row', () => {
	it('writeTree: a member moved into root/ survives a gc before the commit', async () => {
		let fired = 0;
		const vfs = vfsWith('tree-move', async (v, op, path) => {
			if (op === 'move' && path.startsWith('root/') && fired++ === 0) await v.gc();
		});
		await vfs.ready();
		const inbox = await vfs.mkdir(null, 'inbox');
		const files = Array.from({ length: 6 }, (_, i) => ({ path: `a/f-${i}.bin`, body: bytes(i) }));
		const nodes = await vfs.writeTree(inbox.id, files);
		assert.equal(fired > 0, true, 'the hook ran');
		for (const [i, n] of nodes.entries()) {
			const got = new Uint8Array(await (await vfs.readBlob(n.id)).arrayBuffer());
			assert.deepEqual(got, bytes(i), `member ${i} kept its bytes`);
		}
	});

	it('writeTree: staged tmp files survive a gc before they are moved', async () => {
		let fired = 0;
		const vfs = vfsWith('tree-stage', async (v, op, path) => {
			if (op === 'writeFinal' && path.startsWith('tmp/') && fired++ === 0) await v.gc();
		});
		await vfs.ready();
		const nodes = await vfs.writeTree(null, [
			{ path: 'x.bin', body: bytes(1) },
			{ path: 'y.bin', body: bytes(2) }
		]);
		assert.equal(fired > 0, true, 'the hook ran');
		assert.equal(nodes.length, 2);
		for (const [i, n] of nodes.entries()) {
			const got = new Uint8Array(await (await vfs.readBlob(n.id)).arrayBuffer());
			assert.deepEqual(got, bytes(i + 1));
		}
	});

	it('folder rename: files moved under the new name survive a gc before the rows follow', async () => {
		let armed = false;
		const vfs = vfsWith('rename', async (v, op) => {
			if (op === 'movePrefix' && armed) {
				armed = false;
				await v.gc();
			}
		});
		await vfs.ready();
		const dir = await vfs.mkdir(null, 'before');
		const f = await vfs.writeFile({ parentId: dir.id, name: 'keep.bin', body: bytes(7) });
		const ref = await vfs.db.blobRefs.get(f.blobId!);
		assert.ok(ref && ref.opfsPath.startsWith('root/before/'), `unpacked under root: ${ref?.opfsPath}`);
		armed = true;
		await vfs.rename(dir.id, 'after');
		const got = new Uint8Array(await (await vfs.readBlob(f.id)).arrayBuffer());
		assert.deepEqual(got, bytes(7));
	});

	it('a writer that finished leaves nothing that blocks the next gc', async () => {
		const vfs = vfsWith('clean', async () => {});
		await vfs.ready();
		await vfs.writeTree(null, [{ path: 'z.bin', body: bytes(3) }]);
		const leases = await vfs.db.leases.toArray();
		assert.deepEqual(leases, [], 'no lease rows left behind');
		await vfs.opfs.writeFinal('root/stray.bin', bytes(9));
		const report = await vfs.gc();
		assert.equal(report.orphanOpfsRemoved, 1, 'a real orphan is still reclaimed');
	});
});

describe('gc vs a save between its bytes and its row', () => {
	it('updateFile: the staged bytes survive a gc before the node commits', async () => {
		let armed = false;
		resetSharedVfsForTests();
		let vfs!: VfsService;
		const base = createMemoryOpfs();
		const opfs: OpfsBlobStore = {
			...base,
			async writePartial(writeId, data) {
				const r = await base.writePartial(writeId, data as never);
				if (armed) await vfs.gc();
				return r;
			},
			async promote(from, to) {
				await base.promote(from, to);
				if (armed) {
					armed = false;
					await vfs.gc();
				}
			}
		};
		vfs = createVfs({ dbName: `gc-gaps-update-${Date.now()}-${Math.random()}`, opfs, graceMs: -1 });
		await vfs.ready();
		const f = await vfs.writeFile({ parentId: null, name: 'doc.bin', body: bytes(1) });
		armed = true;
		await vfs.updateFile(f.id, bytes(2), { expectedGeneration: f.generation });
		const got = new Uint8Array(await (await vfs.readBlob(f.id)).arrayBuffer());
		assert.deepEqual(got, bytes(2));
	});
});
