import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { acceptRoomContext } from '../src/ui/dualPaneTypes.ts';

describe('acceptRoomContext', () => {
	it('takes a room from any pane and makes it the owner', () => {
		assert.deepEqual(acceptRoomContext(null, 'left', 'r1'), { owner: 'left', apply: true });
		assert.deepEqual(acceptRoomContext('left', 'right', 'r2'), { owner: 'right', apply: true });
	});

	it('ignores null from a pane that does not own the last room', () => {
		assert.deepEqual(acceptRoomContext('left', 'right', null), { owner: 'left', apply: false });
	});

	it('applies null from the owning pane so leaving the project clears presence', () => {
		assert.deepEqual(acceptRoomContext('left', 'left', null), { owner: null, apply: true });
		assert.deepEqual(acceptRoomContext(null, 'right', null), { owner: null, apply: true });
	});
});
