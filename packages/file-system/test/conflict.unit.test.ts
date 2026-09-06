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

	/**
	 * The sequential case above always worked. Two writers *overlapping* did
	 * not: catalog transactions merged instead of isolating, so both read the
	 * same generation, both passed the check, and both published to the same
	 * path. The catalog then named one blob while the file held the other's
	 * bytes, and the next read failed its checksum on a file that was fine.
	 */
	it('two overlapping writers: one wins, and the bytes match the winner', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'race.skch',
			fileType: 'skch',
			body: { v: 0 }
		});
		const results = await Promise.allSettled([
			vfs.updateFile(f.id, { v: 1 }, { expectedGeneration: f.generation }),
			vfs.updateFile(f.id, { v: 2 }, { expectedGeneration: f.generation })
		]);
		const won = results.filter((r) => r.status === 'fulfilled');
		const lost = results.filter((r) => r.status === 'rejected');
		assert.equal(won.length, 1, 'exactly one writer may win the CAS');
		assert.equal(lost.length, 1);
		assert.equal(
			(lost[0] as PromiseRejectedResult).reason?.code,
			'GENERATION_CONFLICT',
			'the loser must lose on the generation check'
		);

		// The point of the test: reading back must not raise a checksum
		// mismatch, and must return whichever value actually won.
		const back = (await vfs.readJson(f.id)) as { v: number };
		assert.ok(back.v === 1 || back.v === 2, `unexpected surviving value ${back.v}`);
		const node = await vfs.get(f.id);
		assert.equal(node?.generation, f.generation + 1, 'exactly one generation bump');
	});
});
