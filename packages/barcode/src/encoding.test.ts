import { describe, expect, it } from 'vitest';
import { base64urlToBytes, bytesToBase64url, latin1ToBase64url } from './encoding.js';

describe('base64url', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 10]);
    expect(Array.from(base64urlToBytes(bytesToBase64url(bytes)))).toEqual(Array.from(bytes));
  });

  it('encodes latin-1 as raw bytes', () => {
    const latin1 = String.fromCharCode(0xff, 0x00, 0x41);
    expect(Array.from(base64urlToBytes(latin1ToBase64url(latin1)))).toEqual([255, 0, 65]);
  });
});
