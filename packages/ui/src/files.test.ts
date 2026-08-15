import { describe, expect, it } from 'vitest';
import { bytesToArrayBuffer, formatBytes } from './files.js';

describe('formatBytes', () => {
	it('formats common sizes', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB');
	});

	it('rejects non-finite input', () => {
		expect(formatBytes(Number.NaN)).toBe('—');
		expect(formatBytes(-1)).toBe('—');
	});
});

describe('bytesToArrayBuffer', () => {
	it('copies into a detached ArrayBuffer', () => {
		const src = new Uint8Array([1, 2, 3]);
		const buf = bytesToArrayBuffer(src);
		expect(buf.byteLength).toBe(3);
		src[0] = 9;
		expect(new Uint8Array(buf)[0]).toBe(1);
	});
});
