import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests } from '../src/index.ts';

/**
 * A lease is live exactly as long as the context that wrote it — judged from
 * the Web Locks that context holds, never from the row's clock. The clock is
 * what let a tab frozen mid-upload lose its file to another tab's GC.
 *
 * The stand-in lock manager here is just enough for that: held names, a query,
 * and `kill` to play a context dying (the browser releasing its locks).
 */
const held = new Map<string, () => void>();

function installLocks(): void {
	const locks = {
		request(name: string, _opts: object, cb: (lock: unknown) => Promise<void> | void) {
			return new Promise<void>((resolve) => {
				if (held.has(name)) return; // contended: never granted in these tests
				let release!: () => void;
				const done = new Promise<void>((r) => (release = r));
				held.set(name, release);
				queueMicrotask(() => {
					void Promise.resolve(cb(name)).then(() => {
						held.delete(name);
						resolve();
					});
					void done.then(() => {
						held.delete(name);
						resolve();
					});
				});
			});
		},
		async query() {
			return { held: [...held.keys()].map((name) => ({ name })) };
		}
	};
	const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
	if (nav) Object.defineProperty(nav, 'locks', { value: locks, configurable: true, writable: true });
	else (globalThis as unknown as { navigator: unknown }).navigator = { locks };
}

/** Another context, alive: it holds its context lock. */
function aliveContext(id: string): void {
	held.set(`vfs-ctx:${id}`, () => held.delete(`vfs-ctx:${id}`));
}

/** That context dies: the browser releases every lock it held. */
function kill(id: string): void {
	held.get(`vfs-ctx:${id}`)?.();
}

describe('lease liveness', () => {
	let vfs: ReturnType<typeof createVfs>;

	before(() => installLocks());

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({
			dbName: `test-lease-live-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			graceMs: 50
		});
		await vfs.ready();
	});

	async function pendingWrite(blobId: string, owner: string, expiresAt: number) {
		const { tmpPath } = await vfs.opfs.writePartial(blobId, new TextEncoder().encode('partial'));
		await vfs.db.blobRefs.put({
			id: blobId,
			opfsPath: tmpPath,
			byteLength: 7,
			// Well past the grace: only the lease can protect it now.
			createdAt: Date.now() - 10 * 60_000,
			pending: true,
			pendingPromote: true
		});
		await vfs.db.leases.put({ key: `write:${blobId}`, owner, expiresAt });
	}

	it("keeps a frozen tab's write, however long its lease has been expired", async () => {
		aliveContext('frozen-tab');
		// Nothing has renewed this for ten minutes — a frozen tab cannot.
		await pendingWrite('frozen-upload', 'frozen-tab/lease-1', Date.now() - 10 * 60_000);
		await vfs.gc();
		assert.ok(await vfs.db.blobRefs.get('frozen-upload'), 'GC deleted a paused write');
		assert.ok(await vfs.db.leases.get('write:frozen-upload'));
	});

	it("reclaims a dead tab's write at once, however fresh its lease looks", async () => {
		aliveContext('closed-tab');
		await pendingWrite('dead-upload', 'closed-tab/lease-1', Date.now() + 60 * 60_000);
		kill('closed-tab');
		await vfs.gc();
		assert.equal(await vfs.db.blobRefs.get('dead-upload'), undefined);
		assert.equal(await vfs.db.leases.get('write:dead-upload'), undefined);
	});

	it('a row without a context stamp is judged by its clock, as before', async () => {
		await pendingWrite('legacy-upload', 'writer-a', Date.now() + 60_000);
		await vfs.gc();
		assert.ok(await vfs.db.blobRefs.get('legacy-upload'));
	});

	it("this context's own writes are stamped and survive GC", async () => {
		const f = await vfs.writeFile({ parentId: null, name: 'mine.txt', body: 'hello' });
		await vfs.gc();
		assert.ok(await vfs.db.nodes.get(f.id));
		const ownLocks = [...held.keys()].filter((n) => n.startsWith('vfs-ctx:'));
		assert.ok(ownLocks.length >= 1, 'this context holds its lock');
	});
});
