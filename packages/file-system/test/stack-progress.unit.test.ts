import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stackTransferItems } from '../src/ui/stackProgress.ts';
import type { TransferItem } from '../src/transferRegistry.ts';

function item(partial: Partial<TransferItem> & Pick<TransferItem, 'id' | 'name'>): TransferItem {
	return {
		size: 100,
		transferred: 0,
		direction: 'copying',
		status: 'active',
		done: false,
		...partial
	};
}

describe('stackTransferItems', () => {
	it('pairs remote + wire into one row with download ahead of transfer', () => {
		const rows = stackTransferItems([
			item({ id: 'op1:remote', name: 'Download · B2', transferred: 80, size: 100 }),
			item({ id: 'op1:wire', name: 'photo.jpg · from peer', transferred: 30, size: 100 })
		]);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.name, 'photo.jpg');
		assert.equal(rows[0]!.ahead, 80);
		assert.equal(rows[0]!.behind, 30);
		assert.deepEqual(rows[0]!.ids.sort(), ['op1:remote', 'op1:wire']);
	});

	it('leaves unpaired copy rows as a single fill', () => {
		const rows = stackTransferItems([
			item({ id: 'copy-1', name: 'note.txt', transferred: 40, size: 80 })
		]);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.ahead, 40);
		assert.equal(rows[0]!.behind, 40);
	});

	it('treats a failed leg as a failed stack', () => {
		const rows = stackTransferItems([
			item({ id: 'op2:remote', name: 'Download · B2', transferred: 10, done: true, status: 'failed', error: 'down' }),
			item({ id: 'op2:wire', name: 'a.bin · to peer', transferred: 0 })
		]);
		assert.equal(rows[0]!.status, 'failed');
		assert.equal(rows[0]!.error, 'down');
	});

	it('treats an unpaired remote or wire row as a single fill', () => {
		const rows = stackTransferItems([
			item({ id: 'op3:remote', name: 'Download · B2', transferred: 25, size: 100 })
		]);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.ahead, 25);
		assert.equal(rows[0]!.behind, 25);
		assert.deepEqual(rows[0]!.ids, ['op3:remote']);
	});

	it('uses wire as the leading fill when upload trails receive (PUT)', () => {
		const rows = stackTransferItems([
			item({ id: 'op4:wire', name: 'clip.wav · to peer', transferred: 90, size: 100 }),
			item({ id: 'op4:remote', name: 'Upload · B2', transferred: 40, size: 100 })
		]);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.ahead, 90);
		assert.equal(rows[0]!.behind, 40);
		assert.equal(rows[0]!.name, 'clip.wav');
	});

	it('keeps unrelated rows next to a stacked pair', () => {
		const rows = stackTransferItems([
			item({ id: 'copy-9', name: 'note.txt', transferred: 10, size: 20 }),
			item({ id: 'op5:remote', name: 'Download · monitor', transferred: 50, size: 100 }),
			item({ id: 'op5:wire', name: 'shot.png · from peer', transferred: 20, size: 100 })
		]);
		assert.equal(rows.length, 2);
		const stack = rows.find((r) => r.id === 'op5:stack');
		const single = rows.find((r) => r.id === 'copy-9');
		assert.equal(stack?.ahead, 50);
		assert.equal(stack?.behind, 20);
		assert.equal(single?.ahead, 10);
		assert.equal(single?.behind, 10);
	});
});
