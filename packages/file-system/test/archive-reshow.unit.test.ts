import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerArchiveDialogShow, requestArchiveDialogShow } from '../src/ui/archiveReshow.ts';

describe('archiveReshow', () => {
	it('returns false with no registered panes', () => {
		assert.equal(requestArchiveDialogShow(), false);
	});

	it('first pane that accepts wins, later ones are not asked', () => {
		let secondCalls = 0;
		const unsub = registerArchiveDialogShow(() => true);
		const unsub2 = registerArchiveDialogShow(() => {
			secondCalls++;
			return true;
		});
		assert.equal(requestArchiveDialogShow(), true);
		assert.equal(secondCalls, 0);
		unsub();
		unsub2();
	});

	it('declining panes fall through to later registrations', () => {
		const unsub = registerArchiveDialogShow(() => false);
		let secondCalls = 0;
		const unsub2 = registerArchiveDialogShow(() => {
			secondCalls++;
			return true;
		});
		assert.equal(requestArchiveDialogShow(), true);
		assert.equal(secondCalls, 1);
		unsub();
		unsub2();
	});

	it('unregistered panes stop answering', () => {
		const unsub = registerArchiveDialogShow(() => true);
		unsub();
		assert.equal(requestArchiveDialogShow(), false);
	});
});