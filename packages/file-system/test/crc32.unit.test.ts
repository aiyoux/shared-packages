import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crc32.ts';

describe('crc32', () => {
	it('matches the IEEE vector for 123456789', () => {
		assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
	});

	it('is stable for a 64KiB buffer', () => {
		const buf = new Uint8Array(64 << 10);
		for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
		const a = crc32(buf);
		const b = crc32(buf);
		assert.equal(a, b);
		assert.notEqual(a, 0);
	});
});
