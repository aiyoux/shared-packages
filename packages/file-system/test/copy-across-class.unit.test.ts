import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalClass, isRemoteClass } from '../src/ui/explorerDriver.ts';
import {
	destParentFromDropEvent,
	FE_EXPLORER_IDS_MIME,
	idsFromExplorerDataTransfer,
	parseExplorerDragIds
} from '../src/ui/copyAcross.ts';

describe('isLocalClass / isRemoteClass', () => {
	it('local-class = local | memory', () => {
		assert.equal(isLocalClass('local'), true);
		assert.equal(isLocalClass('memory'), true);
		assert.equal(isLocalClass('b2'), false);
		assert.equal(isLocalClass('rclone'), false);
		assert.equal(isLocalClass('other'), false);
	});

	it('remote-class = b2 | rclone', () => {
		assert.equal(isRemoteClass('b2'), true);
		assert.equal(isRemoteClass('rclone'), true);
		assert.equal(isRemoteClass('local'), false);
		assert.equal(isRemoteClass('memory'), false);
	});

	it('matrix: remote↔remote both remote-class', () => {
		assert.equal(isRemoteClass('b2') && isRemoteClass('rclone'), true);
		assert.equal(isLocalClass('local') || isLocalClass('b2'), true);
		assert.equal(isLocalClass('b2') || isLocalClass('rclone'), false);
	});
});

describe('cross-pane drag payload', () => {
	it('parseExplorerDragIds splits and trims', () => {
		assert.deepEqual(parseExplorerDragIds(' a, b , ,c '), ['a', 'b', 'c']);
		assert.deepEqual(parseExplorerDragIds(''), []);
	});

	it('idsFromExplorerDataTransfer prefers the explorer mime', () => {
		const dt = {
			getData(type: string) {
				if (type === FE_EXPLORER_IDS_MIME) return 'id1,id2';
				if (type === 'text/plain') return 'ignored';
				return '';
			}
		} as unknown as DataTransfer;
		assert.deepEqual(idsFromExplorerDataTransfer(dt), ['id1', 'id2']);
	});

	it('destParentFromDropEvent uses a folder row id, else fallback', () => {
		const folder = {
			getAttribute(name: string) {
				if (name === 'data-fe-kind') return 'folder';
				if (name === 'data-fe-row-id') return 'fld1';
				return null;
			},
			closest(sel: string) {
				return sel === '[data-fe-row-id]' ? folder : null;
			}
		};
		const name = { closest: (sel: string) => (sel === '[data-fe-row-id]' ? folder : null) };
		assert.equal(destParentFromDropEvent({ target: name as unknown as EventTarget }, 'root'), 'fld1');

		const file = {
			getAttribute(name: string) {
				if (name === 'data-fe-kind') return 'file';
				if (name === 'data-fe-row-id') return 'f1';
				return null;
			},
			closest(sel: string) {
				return sel === '[data-fe-row-id]' ? file : null;
			}
		};
		assert.equal(destParentFromDropEvent({ target: file as unknown as EventTarget }, 'open'), 'open');
		assert.equal(destParentFromDropEvent({ target: null }, 'open'), 'open');
	});
});
