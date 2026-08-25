import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	emptyTrashCopy,
	hardDeleteCopy,
	hardDeletePlace,
	permanentDeleteCopy
} from '../src/ui/feConfirm.ts';

describe('hardDeletePlace', () => {
	it('memory is not remote', () => {
		assert.equal(hardDeletePlace('memory'), 'memory');
		assert.equal(hardDeletePlace('b2'), 'remote');
		assert.equal(hardDeletePlace('rclone'), 'remote');
		assert.equal(hardDeletePlace('monitor'), 'remote');
		assert.equal(hardDeletePlace('disk'), 'disk');
		assert.equal(hardDeletePlace('local'), 'generic');
	});
});

describe('hardDeleteCopy', () => {
	it('remote file mentions remote storage', () => {
		const c = hardDeleteCopy({ driverId: 'rclone', count: 1, folderCount: 0, name: 'x.bin' });
		assert.match(c.body, /remote storage/);
		assert.match(c.body, /x\.bin/);
		assert.doesNotMatch(c.body, /in-memory/i);
	});

	it('memory file does not say remote', () => {
		const c = hardDeleteCopy({ driverId: 'memory', count: 1, folderCount: 0, name: 'clip.wav' });
		assert.doesNotMatch(c.body, /remote/i);
		assert.match(c.body, /clip\.wav/);
		assert.match(c.body, /no trash/);
	});

	it('memory batch does not say remote', () => {
		const c = hardDeleteCopy({ driverId: 'memory', count: 3, folderCount: 0, name: 'a' });
		assert.doesNotMatch(c.body, /remote/i);
		assert.match(c.body, /in-memory/);
		assert.match(c.body, /no trash/);
	});

	it('folder copy names the folder', () => {
		const c = hardDeleteCopy({ driverId: 'b2', count: 1, folderCount: 1, name: 'shots' });
		assert.match(c.body, /folder “shots”/);
		assert.match(c.body, /everything inside/);
	});
});

describe('trash copy', () => {
	it('permanent delete and empty trash do not say remote', () => {
		assert.doesNotMatch(permanentDeleteCopy('A').body, /remote/i);
		assert.match(permanentDeleteCopy('A').body, /“A”/);
		const empty = emptyTrashCopy();
		assert.equal(empty.title, 'Empty trash');
		assert.doesNotMatch(empty.body, /remote/i);
		assert.match(empty.body, /permanently/i);
	});
});
