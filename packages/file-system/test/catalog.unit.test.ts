import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests, MIGRATED_KEY } from '../src/index.ts';

function seedIdbNode(dbName: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(dbName, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains('nodes')) {
				db.createObjectStore('nodes', { keyPath: 'id' });
			}
		};
		req.onerror = () => reject(req.error ?? new Error('idb open failed'));
		req.onsuccess = () => {
			const db = req.result;
			const tx = db.transaction('nodes', 'readwrite');
			const now = Date.now();
			tx.objectStore('nodes').put({
				id: 'n1',
				parentId: null,
				name: 'from-idb.txt',
				kind: 'file',
				createdAt: now,
				updatedAt: now,
				generation: 1
			});
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => {
				db.close();
				reject(tx.error ?? new Error('idb put failed'));
			};
		};
	});
}

describe('SqliteCatalog', () => {
	beforeEach(() => {
		resetSharedVfsForTests();
	});

	it('stamps migrated_from_idb on a fresh catalog', async () => {
		const vfs = createVfs({ dbName: `cat-${Date.now()}`, memoryOpfs: true });
		await vfs.ready();
		const row = await vfs.getMeta(MIGRATED_KEY);
		assert.ok(row, 'fresh install must stamp migrated_from_idb so GC may run');
		assert.equal(vfs.db.migrationOk, true);
	});

	it('copies Dexie nodes into sqlite once', async () => {
		const dbName = `cat-mig-${Date.now()}`;
		await seedIdbNode(dbName);

		const vfs = createVfs({ dbName, memoryOpfs: true });
		await vfs.ready();
		const node = await vfs.get('n1');
		assert.equal(node?.name, 'from-idb.txt');
		const stamp = await vfs.getMeta(MIGRATED_KEY);
		assert.ok(stamp);
	});

	it('does not stamp migrated_from_idb when IDB read fails', async () => {
		const dbName = `cat-fail-${Date.now()}`;
		const orig = indexedDB.open.bind(indexedDB);
		indexedDB.open = (() => {
			throw new Error('idb exploded');
		}) as typeof indexedDB.open;
		try {
			const vfs = createVfs({ dbName, memoryOpfs: true });
			await vfs.ready();
			assert.equal(vfs.db.migrationOk, false);
			const stamp = await vfs.getMeta(MIGRATED_KEY);
			assert.equal(stamp, undefined);
			const report = await vfs.gc();
			assert.equal(report.orphanOpfsRemoved, 0);
			assert.equal(report.unreferencedBlobsRemoved, 0);
		} finally {
			indexedDB.open = orig;
		}
	});

	it('live unique (parent,name) index rejects a second live sibling', async () => {
		const vfs = createVfs({ dbName: `cat-uniq-${Date.now()}`, memoryOpfs: true });
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'uniq');
		const a = await vfs.writeFile({
			parentId: folder.id,
			name: 'same.txt',
			body: new TextEncoder().encode('a')
		});
		await assert.rejects(
			() =>
				vfs.db.nodes.put({
					id: 'other',
					parentId: folder.id,
					name: 'same.txt',
					kind: 'file',
					createdAt: Date.now(),
					updatedAt: Date.now(),
					generation: 1,
					deletedAt: null
				}),
			/UNIQUE|unique/i
		);
		assert.equal(a.name, 'same.txt');
	});

	it('rename updates list()', async () => {
		const vfs = createVfs({ dbName: `cat-ren-${Date.now()}`, memoryOpfs: true });
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'sql-cat');
		const file = await vfs.writeFile({
			parentId: folder.id,
			name: 'note.txt',
			body: new TextEncoder().encode('hello-sql')
		});
		const renamed = await vfs.rename(file.id, 'renamed.txt');
		assert.equal(renamed.id, file.id);
		assert.equal(renamed.name, 'renamed.txt');
		const listed = await vfs.list({ parentId: folder.id });
		assert.deepEqual(
			listed.map((n) => n.name),
			['renamed.txt']
		);
	});

	it('subscribeDraft fires without waking the file bus', async () => {
		const vfs = createVfs({ dbName: `cat-draft-${Date.now()}`, memoryOpfs: true });
		await vfs.ready();
		let fileHits = 0;
		let draftHits = 0;
		const unsubFile = vfs.subscribe(() => {
			fileHits += 1;
		});
		const unsubDraft = vfs.subscribeDraft('d1', (d) => {
			if (d) draftHits += 1;
		});
		await vfs.putDraft({
			id: 'd1',
			appId: 't',
			updatedAt: Date.now(),
			payload: { k: 1 }
		});
		await new Promise((r) => setTimeout(r, 20));
		unsubFile();
		unsubDraft();
		assert.equal(fileHits, 0);
		assert.ok(draftHits >= 1);
	});
});
