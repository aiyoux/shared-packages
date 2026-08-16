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

	it('deflate-raw settles on a large buffer (no write-then-read deadlock)', async () => {
		const large = new TextEncoder().encode(('a=' + 'x'.repeat(80) + '\n').repeat(400));
		const packed = await Promise.race([
			deflateRaw(large),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('deflate-raw hung')), 2_000);
			})
		]);
		expect(packed.byteLength).toBeGreaterThan(0);
		expect(packed.byteLength).toBeLessThan(large.byteLength);
		expect(new TextDecoder().decode(await inflateRaw(packed))).toBe(new TextDecoder().decode(large));
	});
});
