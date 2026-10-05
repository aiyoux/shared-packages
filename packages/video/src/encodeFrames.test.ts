import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioSampleSource } from 'mediabunny';
import { encodeFrames, type FrameSource } from './encodeFrames.js';
import {
	FakeVideoEncoder,
	FakeVideoFrame,
	installCodecs,
	muxOrder,
	type MockAudioSource
} from './encodeTestHarness.js';

vi.mock('mediabunny', async () => (await import('./encodeTestHarness.js')).mediabunnyMock());

let restoreCodecs: (() => void) | undefined;

afterEach(() => {
	restoreCodecs?.();
	restoreCodecs = undefined;
	muxOrder.length = 0;
	(AudioSampleSource as unknown as { instances: unknown[] }).instances.length = 0;
});

describe('encodeFrames', () => {
	it('waits for encoder batches before pulling more offline frames', async () => {
		restoreCodecs = installCodecs();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const flush = vi.spyOn(FakeVideoEncoder.prototype, 'flush').mockImplementationOnce(() => pending);
		const pull = vi.fn(async () => ({}) as CanvasImageSource);
		const exportDone = encodeFrames({ width: 64, height: 64, durationMs: 1000, fps: 60, pull }, { bitrate: '1M' });
		await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
		expect(pull).toHaveBeenCalledTimes(32);
		expect(muxOrder).not.toContain('finalize');
		release();
		await exportDone;
		expect(pull).toHaveBeenCalledTimes(60);
		flush.mockRestore();
	});

	it('uses the fractional output grid rather than accumulating rounded frame intervals', async () => {
		restoreCodecs = installCodecs();
		const fps = 30_000 / 1001;
		await encodeFrames({
			width: 64, height: 64, durationMs: 10_000, fps,
			pull: async () => ({}) as CanvasImageSource
		}, { bitrate: '1M' });
		const frames = FakeVideoEncoder.instances[0]!.frames;
		for (let i = 0; i < frames.length; i++) {
			expect(frames[i]!.timestamp).toBe(Math.round((i / fps) * 1_000_000));
			expect(frames[i]!.duration).toBe(Math.round(((i + 1) / fps) * 1_000_000) - frames[i]!.timestamp);
		}
	});

	it('rebases decoded frames to the output clock when trimming and retiming', async () => {
		restoreCodecs = installCodecs();
		const pulled: FakeVideoFrame[] = [];
		await encodeFrames({
			width: 64, height: 64, durationMs: 300, fps: 10,
			pull: async (tMs) => {
				const frame = new FakeVideoFrame({ id: tMs }, { timestamp: 5_000_000 + tMs * 2000 });
				pulled.push(frame);
				return frame as unknown as VideoFrame;
			}
		}, { bitrate: '1M' });
		const frames = FakeVideoEncoder.instances[0]!.frames;
		expect(frames.map((f) => f.timestamp)).toEqual([0, 100_000, 200_000]);
		expect(frames.map((f) => f.frameId)).toEqual([0, 100, 200]);
		expect(pulled.every((f) => f.closed)).toBe(true);
	});

	it('pulls once per output frame and encodes with stepped PTS', async () => {
		restoreCodecs = installCodecs();
		const pulls: number[] = [];
		const source: FrameSource = {
			width: 64,
			height: 64,
			durationMs: 1000,
			fps: 10,
			pull: vi.fn(async (tMs) => {
				pulls.push(tMs);
				return { kind: 'canvas' } as unknown as CanvasImageSource;
			}),
			close: vi.fn()
		};

		const blob = await encodeFrames(source, { bitrate: '1M' });
		expect(blob.type).toBe('video/mp4');
		expect(source.pull).toHaveBeenCalledTimes(10);
		expect(pulls).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
		expect(source.close).toHaveBeenCalledTimes(1);

		const enc = FakeVideoEncoder.instances[0]!;
		expect(enc.encodeCalls).toHaveLength(10);
		expect(enc.encodeCalls.map((c) => c.timestamp)).toEqual([
			0, 100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000
		]);
		expect(enc.encodeCalls[0]?.keyFrame).toBe(true);
		expect(enc.encodeCalls.slice(1).every((c) => c.keyFrame === false)).toBe(true);
	});

	it('closes the source even when pull throws', async () => {
		restoreCodecs = installCodecs();
		const source: FrameSource = {
			width: 32,
			height: 32,
			durationMs: 100,
			fps: 10,
			pull: vi.fn(async () => {
				throw new Error('pull failed');
			}),
			close: vi.fn()
		};

		await expect(encodeFrames(source, { bitrate: '1M' })).rejects.toThrow('pull failed');
		expect(source.pull).toHaveBeenCalledTimes(1);
		expect(source.close).toHaveBeenCalledTimes(1);
	});

	it('ceils the frame count so the frame overlapping the cut is kept', async () => {
		restoreCodecs = installCodecs();
		const pulls: number[] = [];
		const source: FrameSource = {
			width: 32,
			height: 32,
			durationMs: 1050,
			fps: 10,
			pull: vi.fn(async (tMs) => {
				pulls.push(tMs);
				return { kind: 'canvas' } as unknown as CanvasImageSource;
			})
		};

		await encodeFrames(source, { bitrate: '1M' });
		expect(pulls).toHaveLength(11); // ceil(10.5) — round would give 10 (or 11 by luck)
		expect(pulls[10]).toBe(1000);
	});

	it('drains rebased audio chunks into a lazily added audio track before flush', async () => {
		restoreCodecs = installCodecs();
		const chunks = [
			{
				data: new Uint8Array(new ArrayBuffer(8)),
				format: 'f32' as AudioSampleFormat,
				numberOfChannels: 2,
				sampleRate: 48_000,
				timestamp: 0
			},
			{
				data: new Uint8Array(new ArrayBuffer(8)),
				format: 'f32' as AudioSampleFormat,
				numberOfChannels: 2,
				sampleRate: 48_000,
				timestamp: 0.5
			}
		];
		const source: FrameSource = {
			width: 32,
			height: 32,
			durationMs: 100,
			fps: 10,
			pull: vi.fn(async () => ({ kind: 'canvas' }) as unknown as CanvasImageSource)
		};

		await encodeFrames(source, {
			bitrate: '1M',
			audio: {
				chunks: (async function* () {
					for (const c of chunks) yield c;
				})(),
				codec: 'aac',
				bitrate: 96_000
			}
		});

		expect(muxOrder).toEqual([
			'add-video-track',
			'add-audio-track',
			'start',
			'video-add',
			'audio-add',
			'audio-add',
			'finalize'
		]);
		const audioSource = (AudioSampleSource as unknown as { instances: unknown[] }).instances[0]! as MockAudioSource;
		expect(audioSource.config).toEqual({
			codec: 'aac',
			bitrate: 96_000,
			transform: { sampleRate: 48_000, numberOfChannels: 2 }
		});
		expect(audioSource.adds).toHaveLength(2);
		const first = audioSource.adds[0]!;
		const second = audioSource.adds[1]!;
		expect(first.init.timestamp).toBe(0);
		expect(second.init.timestamp).toBe(0.5);
		expect(second.init.sampleRate).toBe(48_000);
		expect(first.closed).toBe(true);
		expect(second.closed).toBe(true);
	});

	it('adds no audio track when the chunk stream is empty', async () => {
		restoreCodecs = installCodecs();
		const source: FrameSource = {
			width: 32,
			height: 32,
			durationMs: 100,
			fps: 10,
			pull: vi.fn(async () => ({ kind: 'canvas' }) as unknown as CanvasImageSource)
		};

		await encodeFrames(source, {
			bitrate: '1M',
			audio: {
				chunks: (async function* () {})(),
				codec: 'aac'
			}
		});
		expect(muxOrder).not.toContain('add-audio-track');
	});

	it('exports cropped frames when audio decoding finishes after the video pull', async () => {
		restoreCodecs = installCodecs();
		let releaseAudio!: () => void;
		const audioReady = new Promise<void>((resolve) => { releaseAudio = resolve; });
		const source: FrameSource = {
			width: 48, height: 32, durationMs: 200, fps: 10,
			pull: vi.fn(async () => ({ kind: 'cropped-canvas' }) as unknown as CanvasImageSource),
			close: vi.fn()
		};
		const exported = encodeFrames(source, {
			bitrate: '1M',
			audio: { chunks: (async function* () {
				await audioReady;
				yield { data: new Uint8Array(new ArrayBuffer(8)), format: 'f32' as AudioSampleFormat, numberOfChannels: 2, sampleRate: 48_000, timestamp: 0 };
			})() }
		});
		await vi.waitFor(() => expect(FakeVideoEncoder.instances[0]?.encodeCalls).toHaveLength(2));
		expect(muxOrder).toEqual(['add-video-track']);
		releaseAudio();
		expect((await exported).type).toBe('video/mp4');
		expect(muxOrder).toEqual(['add-video-track', 'add-audio-track', 'start', 'video-add', 'video-add', 'audio-add', 'finalize']);
		expect(source.close).toHaveBeenCalledTimes(1);
	});
});
