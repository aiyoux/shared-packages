import { describe, expect, it } from 'vitest';
import { base64urlToBytes, bytesToBase64url } from './base64url.js';

describe('base64url', () => {
	it('round-trips bytes', () => {
		const src = new TextEncoder().encode('scratch-pad+/=');
		const encoded = bytesToBase64url(src);
		expect(encoded).not.toMatch(/[+/=]/);
		expect(new TextDecoder().decode(base64urlToBytes(encoded))).toBe('scratch-pad+/=');
	});
});
