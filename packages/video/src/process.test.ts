import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processVideo } from './process.js';
import { decodeFixture } from './decodeTestHarness.js';
import { FakeVideoEncoder, installCodecs, muxOrder } from './encodeTestHarness.js';

vi.mock('mediabunny', async () => ({
	...(await import('./encodeTestHarness.js')).mediabunnyMock(),
	...(await import('./decodeTestHarness.js')).decodeMock()
}));
vi.mock('./audio.js', () => ({ openAudioChunks: async function* () {} }));

let restore: () => void;
beforeEach(() => { decodeFixture.reset(); muxOrder.length = 0; restore = installCodecs(); });
afterEach(() => restore());

describe('source-timed video processing', () => {
	it('keeps the final frame when the container omits its duration', async () => {
		decodeFixture.frames = [
			{ id: 0, timestamp: 0, duration: 0.04 },
			{ id: 1, timestamp: 0.04, duration: 0 }
		];
		await processVideo(new Blob(), { start: 0, end: 0.08, bitrate: '1M', fpsHint: 25 });
		expect(FakeVideoEncoder.instances[0]?.frames.map((f) => [f.frameId, f.timestamp, f.duration])).toEqual([
			[0, 0, 40_000], [1, 40_000, 40_000]
		]);
	});

	it('preserves irregular source PTS and the frame spanning the trim start', async () => {
		decodeFixture.frames = [
			{ id: 0, timestamp: 0.95, duration: 0.08 },
			{ id: 1, timestamp: 1.03, duration: 0.02 },
			{ id: 2, timestamp: 1.05, duration: 0.045 },
			{ id: 3, timestamp: 1.095, duration: 0.04 },
			{ id: 4, timestamp: 1.135, duration: 0.04 }
		];
		const onProgress = vi.fn();
		const blob = await processVideo(new Blob(), { start: 1, end: 1.1, bitrate: '1M', onProgress });
		expect(blob.type).toBe('video/mp4');
		const encoder = FakeVideoEncoder.instances[0]!;
		expect(encoder.frames.map((f) => f.frameId)).toEqual([0, 1, 2, 3]);
		expect(encoder.frames.map((f) => f.timestamp)).toEqual([0, 30_000, 50_000, 95_000]);
		expect(encoder.frames.map((f) => f.duration)).toEqual([30_000, 20_000, 45_000, 5_000]);
		expect(onProgress).toHaveBeenLastCalledWith(100);
		expect(decodeFixture.inputs[0]?.disposed).toBe(true);
	});

	it('exports all high-rate frames even when audio is enabled on a silent source', async () => {
		decodeFixture.frames = Array.from({ length: 120 }, (_, id) => ({ id, timestamp: id / 120, duration: 1 / 120 }));
		await processVideo(new Blob(), { start: 0, end: 1, fpsHint: 120, bitrate: '1M', audio: { codec: 'aac' } });
		expect(FakeVideoEncoder.instances[0]?.frames.map((f) => f.frameId)).toEqual(Array.from({ length: 120 }, (_, id) => id));
		expect(muxOrder).not.toContain('add-audio-track');
		expect(muxOrder.at(-1)).toBe('finalize');
	});

	it('cleans up decoded input on an empty trim result', async () => {
		decodeFixture.frames = [{ id: 0, timestamp: 0, duration: 0.1 }];
		await expect(processVideo(new Blob(), { start: 1, end: 2, bitrate: '1M' })).rejects.toThrow(/No video frames/);
		expect(decodeFixture.inputs[0]?.disposed).toBe(true);
	});
});
