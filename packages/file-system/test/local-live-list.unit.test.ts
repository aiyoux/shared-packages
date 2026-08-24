import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests } from '../src/index.ts';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
		await wait(stepMs);
	}
}

describe('LocalExplorerDriver liveList subscribeChanges', () => {
	beforeEach(() => {
		resetSharedVfsForTests();
	});

	it('fires when another VfsService instance on the same dbName writes a file', async () => {
		const dbName = `live-xinst-${Date.now()}-${Math.random()}`;
		const a = createVfs({ dbName, memoryOpfs: true, requestPersist: false });
		const b = createVfs({ dbName, memoryOpfs: true, requestPersist: false });
		await a.ready();
		await b.ready();
		const drv = createLocalExplorerDriver(a);
		const subscribe = drv.subscribeChanges;
		assert.ok(subscribe);
		let hits = 0;
		const unsub = subscribe(() => {
			hits += 1;
		}, { parentId: null });
		try {
			await wait(50);
			const before = hits;
			await b.writeFile({ parentId: null, name: 'from-other-instance.txt', body: 'x' });
			await waitFor(() => hits > before);
		} finally {
			unsub();
		}
	});

	it('falls back to changeBus when liveList is missing', async () => {
		const vfs = createVfs({
			dbName: `live-nolive-${Date.now()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		Object.defineProperty(vfs, 'liveList', { value: undefined });
		const drv = createLocalExplorerDriver(vfs);
		const subscribe = drv.subscribeChanges;
		assert.ok(subscribe);
		let hits = 0;
		const unsub = subscribe(() => {
			hits += 1;
		}, { parentId: null });
		await vfs.writeFile({ parentId: null, name: 'via-bus.txt', body: 'y' });
		assert.ok(hits >= 1, `expected changeBus notify, got ${hits}`);
		unsub();
	});
});
