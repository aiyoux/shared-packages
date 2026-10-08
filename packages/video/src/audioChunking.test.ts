import { describe, expect, it } from 'vitest';
import { audioChunkingError, DEFAULT_AUDIO_CHUNK_SECONDS, DEFAULT_AUDIO_OVERLAP_SECONDS } from './audioChunking.js';

describe('UniverSR chunk settings', () => {
	it('accepts defaults, decimal seconds, zero overlap and half-window overlap', () => {
		for (const [chunk, overlap] of [[DEFAULT_AUDIO_CHUNK_SECONDS, DEFAULT_AUDIO_OVERLAP_SECONDS], [2.5, 0.1], [1, 0], [1, 0.5], [60, 5]]) {
			expect(audioChunkingError(chunk, overlap)).toBe('');
		}
	});
	it('rejects missing, non-finite, out-of-range and excessive overlap values', () => {
		for (const [chunk, overlap] of [[undefined, 0], [5, undefined], [NaN, 0], [5, Infinity], [0, 0], [61, 0], [5, -1], [5, 3], [60, 6]]) {
			expect(audioChunkingError(chunk, overlap)).not.toBe('');
		}
	});
});
