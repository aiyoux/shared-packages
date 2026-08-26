import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VfsError } from '../src/types.ts';
import {
	saveWithConflictConfirm,
	openFileWithGuard,
	SaveCancelledError
} from '../src/ui/saveFlow.ts';
import { overwriteSaveCopy } from '../src/ui/feConfirm.ts';

function conflict() {
	return new VfsError('GENERATION_CONFLICT', 'File changed in another tab');
}

describe('saveWithConflictConfirm', () => {
	it('passes through a clean save (no force retry)', async () => {
		const calls: boolean[] = [];
		const out = await saveWithConflictConfirm(async (force) => {
			calls.push(Boolean(force));
			return 'ok';
		});
		assert.equal(out, 'ok');
		assert.deepEqual(calls, [false]);
	});

	it('confirms and retries with force on GENERATION_CONFLICT', async () => {
		let first = true;
		const confirm = () => true;
		const out = await saveWithConflictConfirm(
			async (force) => {
				if (first) {
					first = false;
					throw conflict();
				}
				assert.equal(force, true);
				return 'saved-force';
			},
			{ confirm }
		);
		assert.equal(out, 'saved-force');
	});

	it('throws SaveCancelledError when the user declines', async () => {
		const confirm = () => false;
		await assert.rejects(
			saveWithConflictConfirm(
				async () => {
					throw conflict();
				},
				{ confirm }
			),
			(e: unknown) => e instanceof SaveCancelledError
		);
	});

	it('rethrows non-conflict errors', async () => {
		await assert.rejects(
			saveWithConflictConfirm(async () => {
				throw new Error('boom');
			}),
			(e: unknown) => e instanceof Error && e.message === 'boom'
		);
	});

	it('uses the default message', async () => {
		let seen = '';
		await assert.rejects(
			saveWithConflictConfirm(
				async () => {
					throw conflict();
				},
				{ confirm: (m) => ((seen = m), false) }
			),
			(e: unknown) => e instanceof SaveCancelledError
		);
		assert.match(seen, /changed in another tab/);
	});
});

describe('openFileWithGuard', () => {
	function choices(seq: string[]) {
		let i = 0;
		return async () => (seq[i++] as 'discard' | 'save' | 'continue') ?? 'continue';
	}

	it('opens immediately when clean (no dialog)', async () => {
		let opened = 0;
		const result = await openFileWithGuard({
			isDirty: false,
			onSaveAndOpen: async () => true,
			onDiscardAndOpen: async () => {
				opened += 1;
			},
			showDialog: async () => {
				throw new Error('dialog should not show');
			}
		});
		assert.equal(result, 'opened');
		assert.equal(opened, 1);
	});

	it('discard → opens', async () => {
		let opened = 0;
		const result = await openFileWithGuard({
			isDirty: true,
			onSaveAndOpen: async () => {
				throw new Error('should not save');
			},
			onDiscardAndOpen: async () => {
				opened += 1;
			},
			showDialog: choices(['discard'])
		});
		assert.equal(result, 'opened');
		assert.equal(opened, 1);
	});

	it('save + saved → opens after saving', async () => {
		const order: string[] = [];
		const result = await openFileWithGuard({
			isDirty: true,
			onSaveAndOpen: async () => {
				order.push('save');
				return true;
			},
			onDiscardAndOpen: async () => {
				order.push('open');
			},
			showDialog: choices(['save'])
		});
		assert.equal(result, 'opened');
		assert.deepEqual(order, ['save', 'open']);
	});

	it('save + cancelled save flow → does not open', async () => {
		let opened = 0;
		const result = await openFileWithGuard({
			isDirty: true,
			onSaveAndOpen: async () => false,
			onDiscardAndOpen: async () => {
				opened += 1;
			},
			showDialog: choices(['save'])
		});
		assert.equal(result, 'continue-editing');
		assert.equal(opened, 0);
	});

	it('continue → does not open or save', async () => {
		let opened = 0;
		const result = await openFileWithGuard({
			isDirty: true,
			onSaveAndOpen: async () => {
				throw new Error('should not save');
			},
			onDiscardAndOpen: async () => {
				opened += 1;
			},
			showDialog: choices(['continue'])
		});
		assert.equal(result, 'continue-editing');
		assert.equal(opened, 0);
	});
});

describe('overwriteSaveCopy', () => {
	it('names the file and asks to replace', () => {
		const c = overwriteSaveCopy('report.skch');
		assert.equal(c.title, 'Overwrite file?');
		assert.match(c.body, /report\.skch/);
		assert.match(c.body, /already exists/);
		assert.equal(c.confirmLabel, 'Overwrite');
	});
});
