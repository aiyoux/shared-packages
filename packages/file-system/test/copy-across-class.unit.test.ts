import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalClass, isRemoteClass } from '../src/ui/explorerDriver.ts';

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
