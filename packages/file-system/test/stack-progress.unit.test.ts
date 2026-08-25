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

	it('passes hop/ice through stacked and single rows', () => {
		const stacked = stackTransferItems([
			item({
				id: 'op1:remote',
				name: 'Download · B2',
				transferred: 80,
				size: 100,
				hop: 'dual-phase',
				hopNote: 'Through this device'
			}),
			item({
				id: 'op1:wire',
				name: 'photo.jpg',
				transferred: 30,
				size: 100,
				hop: 'dual-phase',
				hopNote: 'Through this device'
			})
		]);
		assert.equal(stacked[0]!.hop, 'dual-phase');
		assert.equal(stacked[0]!.hopNote, 'Through this device');

		const single = stackTransferItems([
			item({
				id: 'w1',
				name: 'a.bin',
				transferred: 4,
				size: 8,
				hop: 'webrtc',
				ice: 'checking',
				icePath: 'host'
			})
		]);
		assert.equal(single[0]!.hop, 'webrtc');
		assert.equal(single[0]!.ice, 'checking');
		assert.equal(single[0]!.icePath, 'host');
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

	it('normalises compress + wire legs with different totals onto the original size', () => {
		const rows = stackTransferItems([
			item({
				id: 'op6:compress',
				name: 'notes.txt',
				transferred: 1000,
				size: 1000,
				done: true,
				status: 'done',
				direction: 'sending'
			}),
			item({
				id: 'op6:wire',
				name: 'notes.txt',
				transferred: 200,
				size: 400,
				direction: 'sending'
			})
		]);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.size, 1000);
		assert.equal(rows[0]!.ahead, 1000);
		assert.equal(rows[0]!.behind, 500);
		assert.equal(rows[0]!.phase, 'transfer');
	});

	it('marks the stack as compressing / decompressing from the active leg', () => {
		const compressing = stackTransferItems([
			item({
				id: 'op7:compress',
				name: 'a.txt',
				transferred: 0,
				size: 800,
				direction: 'sending'
			})
		]);
		assert.equal(compressing[0]!.phase, 'compress');

		const decompressing = stackTransferItems([
			item({
				id: 'op8:wire',
				name: 'a.txt',
				transferred: 400,
				size: 400,
				done: true,
				status: 'done',
				direction: 'receiving'
			}),
			item({
				id: 'op8:decompress',
				name: 'a.txt',
				transferred: 0,
				size: 400,
				direction: 'receiving'
			})
		]);
		assert.equal(decompressing[0]!.phase, 'decompress');
		assert.equal(decompressing[0]!.ahead, 400);
		assert.equal(decompressing[0]!.behind, 0);
	});

	it('exposes streamed bytes when the wire size is still unknown', () => {
		const rows = stackTransferItems([
			item({
				id: 'op9:compress',
				name: 'dump.sql',
				transferred: 16_000_000,
				size: 40_000_000,
				direction: 'sending'
			}),
			item({
				id: 'op9:wire',
				name: 'dump.sql',
				transferred: 1_200_000,
				size: 0,
				direction: 'sending'
			})
		]);
		assert.equal(rows[0]!.phase, 'compress');
		assert.equal(rows[0]!.streamedBytes, 1_200_000);
		assert.equal(rows[0]!.size, 40_000_000);
	});
});
