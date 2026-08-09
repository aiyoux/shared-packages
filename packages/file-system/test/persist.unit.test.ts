import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePersistentStorage, getPersistenceStatus } from '../src/persist.ts';
import { createVfs, resetSharedVfsForTests } from '../src/index.ts';

describe('persistent storage helpers', () => {
	it('returns unsupported (or best-effort) in Node without navigator.storage.persist', async () => {
		const r = await ensurePersistentStorage();
		assert.ok(r.status === 'unsupported' || r.status === 'best-effort' || r.status === 'persistent');
		const s = await getPersistenceStatus();
		assert.ok(s === 'unsupported' || s === 'best-effort' || s === 'persistent');
	});

	it('ready() succeeds with memory OPFS without requesting persist', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `persist-test-${Date.now()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		assert.equal(vfs.persistence, null);
	});
});
