import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests } from '../src/vfs.ts';
import {
	getMemoryVfs,
	resetMemoryVfsForTests
} from '../src/memoryVfs.ts';

describe('VFS live subscribe', () => {
	it('durable writeFile notifies subscribers', async () => {
		resetSharedVfsForTests();
		const vfs = createVfs({
			dbName: `live-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		let n = 0;
		const unsub = vfs.subscribe(() => {
			n += 1;
		});
		await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'x' });
		assert.ok(n >= 1, `expected notify, got ${n}`);
		const after = n;
		unsub();
		await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'y' });
		assert.equal(n, after);
	});

	it('memory writeFile notifies all wrappers of the global store', async () => {
		resetMemoryVfsForTests();
		const a = getMemoryVfs();
		const b = getMemoryVfs();
		let hits = 0;
		const ua = a.subscribe(() => {
			hits += 1;
		});
		const ub = b.subscribe(() => {
			hits += 1;
		});
		await a.writeFile({ parentId: null, name: 'm.txt', body: 'z' });
		assert.equal(hits, 2);
		ua();
		ub();
	});
});
