import { describe, expect, it } from 'vitest';
import { deflateRaw, gunzipBytes, gzipBytes, inflateRaw } from './streams.js';

const SAMPLE = new TextEncoder().encode('scratch-pad stream fixture\n'.repeat(20));

describe('native CompressionStream codecs', () => {
	it('round-trips deflate-raw', async () => {
		const packed = await deflateRaw(SAMPLE);
		expect(packed.byteLength).toBeLessThan(SAMPLE.byteLength);
		expect(new TextDecoder().decode(await inflateRaw(packed))).toBe(new TextDecoder().decode(SAMPLE));
	});

	it('round-trips gzip', async () => {
		const packed = await gzipBytes(SAMPLE);
		expect(packed[0]).toBe(0x1f);
		expect(packed[1]).toBe(0x8b);
		expect(new TextDecoder().decode(await gunzipBytes(packed))).toBe(new TextDecoder().decode(SAMPLE));
	});
});
