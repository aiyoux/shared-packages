import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioSample, AudioSampleSource } from 'mediabunny';
import { avcLevelByte, createEncodeSession, parseBitrate } from './encodeSession.js';
import {
	FakeVideoEncoder,
	FakeVideoFrame,
	installCodecs,
	muxOrder,
	type MockAudioSource
} from './encodeTestHarness.js';

vi.mock('mediabunny', async () => (await import('./encodeTestHarness.js')).mediabunnyMock());

function frame(timestamp: number): VideoFrame {
	return new FakeVideoFrame(undefined, { timestamp }) as unknown as VideoFrame;
}

let restoreCodecs: (() => void) | undefined;

afterEach(() => {
	restoreCodecs?.();
	restoreCodecs = undefined;
	muxOrder.length = 0;
	(AudioSampleSource as unknown as { instances: unknown[] }).instances.length = 0;
});

describe('avcLevelByte / parseBitrate', () => {
	it('picks H.264 levels from coded macroblocks', () => {
		expect(avcLevelByte(640, 360)).toBe('1F');
		expect(avcLevelByte(1280, 720)).toBe('1F');
		expect(avcLevelByte(1920, 1080)).toBe('28');
		expect(avcLevelByte(3840, 2160)).toBe('33');
	});

	it('parses bitrate suffixes', () => {
		expect(parseBitrate('500k')).toBe(500_000);
		expect(parseBitrate('2M')).toBe(2_000_000);
	});
});

describe('createEncodeSession', () => {
	it('throws without WebCodecs', () => {
		const prevEnc = globalThis.VideoEncoder;
		const prevFrame = globalThis.VideoFrame;
		// @ts-expect-error — node has no WebCodecs
		delete globalThis.VideoEncoder;
		// @ts-expect-error
		delete globalThis.VideoFrame;
		try {
			expect(() =>
				createEncodeSession({ width: 64, height: 64, bitrate: '1M' })
			).toThrow(/WebCodecs/);
		} finally {
			globalThis.VideoEncoder = prevEnc;
			globalThis.VideoFrame = prevFrame;
		}
	});

	it('snaps odd sizes, configures AVC, and keys the first frame plus every 2s of PTS', async () => {
		restoreCodecs = installCodecs();
		const progress: number[] = [];
		const session = createEncodeSession({
			width: 1919,
			height: 1079,
			bitrate: '2M',
			fpsHint: 24,
			onProgress: (n) => progress.push(n)
		});

		expect(session.width).toBe(1918);
		expect(session.height).toBe(1078);

		const enc = FakeVideoEncoder.instances[0]!;
		expect(enc.configureCalls[0]).toMatchObject({
			codec: `avc1.42E0${avcLevelByte(1918, 1078)}`,
			width: 1918,
			height: 1078,
			bitrate: 2_000_000,
			framerate: 24
		});

		session.encode(frame(0));
		session.encode(frame(1_000_000));
		session.encode(frame(2_000_000));
		session.encode(frame(2_500_000), { keyFrame: true });
		session.encode(frame(2_600_000));

		expect(enc.encodeCalls).toEqual([
			{ timestamp: 0, keyFrame: true },
			{ timestamp: 1_000_000, keyFrame: false },
			{ timestamp: 2_000_000, keyFrame: true },
			{ timestamp: 2_500_000, keyFrame: true },
			{ timestamp: 2_600_000, keyFrame: false }
		]);
		expect(progress).toEqual([1, 2, 3, 4, 5]);

		const blob = await session.flush();
		expect(blob).toBeInstanceOf(Blob);
		expect(blob.type).toBe('video/mp4');
		expect(enc.flushCount).toBe(1);
		session.close();
		expect(enc.closeCount).toBe(1);
	});
});

describe('encodeSession audio', () => {
	it('adds the audio track lazily on the first sample', async () => {
		restoreCodecs = installCodecs();
		const session = createEncodeSession({
			width: 64,
			height: 64,
			bitrate: '1M',
			audio: { codec: 'opus', bitrate: 96_000 }
		});
		// Source creation is lazy — nothing exists until the first sample.
		expect((AudioSampleSource as unknown as { instances: unknown[] }).instances).toHaveLength(0);
		expect(muxOrder).toEqual(['add-video-track']);

		const sample = new AudioSample({
			data: new Uint8Array(new ArrayBuffer(4)),
			format: 'f32',
			numberOfChannels: 1,
			sampleRate: 48_000,
			timestamp: 0.25
		}) as unknown as Parameters<typeof session.addAudio>[0];
		await session.addAudio(sample, { sampleRate: 48_000, numberOfChannels: 1 });

		const audioSource = (AudioSampleSource as unknown as { instances: unknown[] }).instances[0]! as MockAudioSource;
		expect(audioSource.config).toEqual({
			codec: 'opus',
			bitrate: 96_000,
			transform: { sampleRate: 48_000, numberOfChannels: 1 }
		});

		session.encode(frame(0));
		await session.flush();
		expect(muxOrder).toEqual(['add-video-track', 'add-audio-track', 'start', 'audio-add', 'video-add', 'finalize']);
		session.close();
	});

	it('emits no audio track when addAudio is never called', async () => {
		restoreCodecs = installCodecs();
		const session = createEncodeSession({ width: 64, height: 64, bitrate: '1M' });
		expect((AudioSampleSource as unknown as { instances: unknown[] }).instances).toHaveLength(0);
		session.encode(frame(0));
		await session.flush();
		expect(muxOrder).toEqual(['add-video-track', 'start', 'video-add', 'finalize']);
		session.close();
	});

	it('registers delayed audio before starting, even when video packets arrive first', async () => {
		restoreCodecs = installCodecs();
		const session = createEncodeSession({ width: 64, height: 64, bitrate: '1M', audio: {} });
		session.encode(frame(0));
		await Promise.resolve();
		expect(muxOrder).toEqual(['add-video-track']);
		const sample = new AudioSample({ data: new Uint8Array(8), format: 'f32', numberOfChannels: 2, sampleRate: 48_000, timestamp: 0 });
		await session.addAudio(sample);
		const blob = await session.flush();
		expect(blob.type).toBe('video/mp4');
		expect(muxOrder).toEqual(['add-video-track', 'add-audio-track', 'start', 'video-add', 'audio-add', 'finalize']);
		session.close();
	});

	it('starts video-only output when an enabled audio stream finishes empty', async () => {
		restoreCodecs = installCodecs();
		const session = createEncodeSession({ width: 64, height: 64, bitrate: '1M', audio: {} });
		session.encode(frame(0));
		session.finishAudio();
		await vi.waitFor(() => expect(muxOrder).toContain('video-add'));
		expect(muxOrder).toEqual(['add-video-track', 'start', 'video-add']);
		await session.flush(); session.close();
		expect(muxOrder.filter((call) => call === 'start')).toHaveLength(1);
	});

	it('rejects audio after its stream is finished or the session is cancelled', async () => {
		restoreCodecs = installCodecs();
		const sample = new AudioSample({ data: new Uint8Array(8), format: 'f32', numberOfChannels: 2, sampleRate: 48_000, timestamp: 0 });
		const finished = createEncodeSession({ width: 64, height: 64, bitrate: '1M', audio: {} });
		finished.finishAudio();
		await expect(finished.addAudio(sample)).rejects.toThrow(/audio is closed/);
		finished.close();
		const cancelled = createEncodeSession({ width: 64, height: 64, bitrate: '1M', audio: {} });
		cancelled.encode(frame(0));
		cancelled.close();
		await expect(cancelled.addAudio(sample)).rejects.toThrow(/audio is closed/);
		expect(muxOrder.filter((call) => call === 'start')).toHaveLength(1);
	});
});

describe('encodeSession empty output', () => {
	it('refuses to finalize when no frame was encoded', async () => {
		restoreCodecs = installCodecs();
		const session = createEncodeSession({ width: 64, height: 64, bitrate: '1M' });
		await expect(session.flush()).rejects.toThrow(/No video frames were captured/);
		expect(muxOrder).not.toContain('finalize');
		session.close();
	});

	it('refuses to finalize when the encoder returns no data', async () => {
		restoreCodecs = installCodecs();
		FakeVideoEncoder.silent = true;
		const session = createEncodeSession({ width: 64, height: 64, bitrate: '1M' });
		session.encode(frame(0));
		session.encode(frame(33_333));
		await expect(session.flush()).rejects.toThrow(/encoder \(avc1\.42E0\w+, 64×64\) returned no data for 2 frames/);
		expect(muxOrder).not.toContain('finalize');
		session.close();
	});
});
