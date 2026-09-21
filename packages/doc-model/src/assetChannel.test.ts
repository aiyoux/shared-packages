import { describe, expect, it } from 'vitest';
import {
	assetFrames,
	assetHash,
	chunkAsset,
	reassembleAsset
} from './collab.js';

describe('asset channel payload helpers', () => {
	it('chunkAsset + reassembleAsset round-trip exact bytes', () => {
		const bytes = new Uint8Array(200_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) & 0xff;
		const chunks = chunkAsset(bytes, 64 * 1024);
		expect(chunks.length).toBe(Math.ceil(200_000 / (64 * 1024)));
		expect(reassembleAsset(chunks)).toEqual(bytes);
	});

	it('an empty asset is one empty chunk and reassembles empty', () => {
		const chunks = chunkAsset(new Uint8Array(0));
		expect(chunks).toEqual(['']);
		expect(reassembleAsset(chunks).length).toBe(0);
	});

	it('assetFrames stamps one hash across all frames and completes at total - 1', () => {
		const bytes = new TextEncoder().encode('png-bytes');
		const { hash, frames } = assetFrames('assets/pic.png', bytes, {
			pageId: 'page-1',
			clientId: 'c1',
			roomId: 'room'
		});
		expect(frames.length).toBe(1);
		expect(frames[0]).toMatchObject({
			kind: 'asset',
			src: 'assets/pic.png',
			hash,
			index: 0,
			total: 1
		});
		// seq is deliberately absent from asset frames: the envelope seq is
		// checkpoint-stamped (offline-project-collab §5.3) and asset frames
		// must never mean two things there.
		expect('seq' in frames[0]!).toBe(false);
		expect(hash).toBe(assetHash(bytes));
	});

	it('multi-chunk frames carry an increasing index and identical hash', () => {
		const bytes = new Uint8Array(150_000).fill(7);
		const { frames } = assetFrames('assets/big.bin', bytes, { pageId: 'p', clientId: 'c' });
		expect(frames.length).toBe(3);
		expect(frames.map((f) => f.index)).toEqual([0, 1, 2]);
		expect(new Set(frames.map((f) => f.hash)).size).toBe(1);
		expect(reassembleAsset(frames.map((f) => f.chunk))).toEqual(bytes);
	});

	it('assetHash distinguishes payloads', () => {
		expect(assetHash(new Uint8Array([1, 2, 3]))).not.toBe(assetHash(new Uint8Array([1, 2, 4])));
		expect(assetHash(new Uint8Array([1, 2, 3]))).toBe(assetHash(new Uint8Array([1, 2, 3])));
	});
});