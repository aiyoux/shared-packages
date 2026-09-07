import { describe, expect, it } from 'vitest';
import { decideWrite, fingerprintBytes, fingerprintText } from './bytesGate.js';

const bytes = (...v: number[]) => new Uint8Array(v);

describe('fingerprintBytes', () => {
	it('is stable and length-prefixed', () => {
		expect(fingerprintBytes(bytes(1, 2, 3))).toBe(fingerprintBytes(bytes(1, 2, 3)));
		expect(fingerprintBytes(bytes(1, 2, 3)).startsWith('3:')).toBe(true);
	});

	it('separates same-length different content', () => {
		expect(fingerprintBytes(bytes(1, 2, 3))).not.toBe(fingerprintBytes(bytes(1, 2, 4)));
	});

	it('handles empty input', () => {
		expect(fingerprintBytes(bytes())).toBe('0:0');
	});
});

describe('fingerprintText', () => {
	it('distinguishes documents that differ by one character', () => {
		expect(fingerprintText('{"a":1}')).not.toBe(fingerprintText('{"a":2}'));
	});
});

describe('decideWrite', () => {
	// W17 — the property the whole convergence argument rests on.
	it('skips the write when the bytes are unchanged', () => {
		const first = decideWrite(undefined, bytes(1, 2, 3));
		expect(first.write).toBe(true);
		expect(decideWrite(first.fingerprint, bytes(1, 2, 3)).write).toBe(false);
	});

	it('writes when the content changes at the same length', () => {
		const first = decideWrite(undefined, bytes(1, 2, 3));
		expect(decideWrite(first.fingerprint, bytes(1, 2, 4)).write).toBe(true);
	});

	it('writes when the length changes', () => {
		const first = decideWrite(undefined, bytes(1, 2, 3));
		expect(decideWrite(first.fingerprint, bytes(1, 2, 3, 4)).write).toBe(true);
	});

	// Without this, dropping the output (a revoked object URL) would be
	// permanent: the fingerprint still matches, so nothing would ever rewrite.
	it('writes again when the stored output is gone', () => {
		const first = decideWrite(undefined, bytes(1, 2, 3));
		expect(decideWrite(first.fingerprint, bytes(1, 2, 3), false).write).toBe(true);
	});

	it('always returns the fingerprint of the new bytes', () => {
		const decision = decideWrite('9:deadbeef', bytes(1, 2, 3));
		expect(decision.fingerprint).toBe(fingerprintBytes(bytes(1, 2, 3)));
	});
});
