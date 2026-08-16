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

	/**
	 * Corrupt input must reject cleanly with BOTH stream sides handled. If the
	 * writer's rejection (or the readable's) is ever left dangling again, vitest
	 * reports it as an unhandled error and fails this file even though the
	 * `rejects` assertions below still pass — which is exactly how the original
	 * bug hid: 8 green tests, exit code 1.
	 *
	 * This is not a synthetic case. `isAcceptableScanText` inflates every code
	 * the /cm camera decodes, so garbage in is the steady state while aiming.
	 */
	it('rejects corrupt input without leaking an unhandled rejection', async () => {
		const garbage = new TextEncoder().encode('not a deflate stream at all');
		await expect(inflateRaw(garbage)).rejects.toThrow();
		await expect(gunzipBytes(garbage)).rejects.toThrow();

		// A truncated-but-plausible payload takes a different zlib error path.
		const truncated = (await deflateRaw(SAMPLE)).slice(0, 6);
		await expect(inflateRaw(truncated)).rejects.toThrow();
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
