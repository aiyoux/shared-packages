import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests } from '../src/index.ts';
import { runDataLossMatrix, seq2Cases } from './data-loss-matrix.ts';

// Separate files keep each 168-case sweep within the package's per-file budget.
it('preserves every file’s own bytes (packed, 168 cases)', async () => {
	resetSharedVfsForTests();
	const vfs = createVfs({ dbName: 'matrix-packed', memoryOpfs: true });
	try {
		await vfs.ready();
		const failures = await runDataLossMatrix(vfs, seq2Cases(), true);
		assert.deepEqual(failures, [], JSON.stringify(failures.slice(0, 12), null, 2));
	} finally {
		await vfs.db.delete();
		resetSharedVfsForTests();
	}
});
