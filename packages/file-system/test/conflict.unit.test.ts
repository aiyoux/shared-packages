import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, VfsError, resetSharedVfsForTests } from '../src/index.ts';

describe('generation conflict', () => {
	let vfs: ReturnType<typeof createVfs>;

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({ dbName: `conflict-${Date.now()}-${Math.random()}`, memoryOpfs: true });
		await vfs.ready();
	});

	it('two writers: second CAS fails; force succeeds', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'c.skch',
			fileType: 'skch',
			body: { v: 0 }
		});
		const a = await vfs.updateFile(f.id, { v: 1 }, { expectedGeneration: f.generation });
		await assert.rejects(
			() => vfs.updateFile(f.id, { v: 2 }, { expectedGeneration: f.generation }),
			(e: unknown) => e instanceof VfsError && e.code === 'GENERATION_CONFLICT'
		);
		const forced = await vfs.updateFile(f.id, { v: 3 }, { force: true });
		assert.equal(forced.generation, a.generation + 1);
		assert.deepEqual(await vfs.readJson(f.id), { v: 3 });
	});
});
