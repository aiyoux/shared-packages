import { describe, expect, it, vi } from 'vitest';
import { probeVideoMetadata } from './probe.js';

const inputFakes = {
	getFormat: vi.fn(),
	getMimeType: vi.fn(),
	getPrimaryVideoTrack: vi.fn(),
	getPrimaryAudioTrack: vi.fn(),
	getDurationFromMetadata: vi.fn(),
	dispose: vi.fn()
};

vi.mock('mediabunny', () => {
	class BlobSource {
		constructor(_blob: unknown) {}
	}
	const ALL_FORMATS = ['mp4', 'webm'];
	class Input {
		constructor(_opts: unknown) {}
		getFormat() {
			return inputFakes.getFormat();
		}
		getMimeType() {
			return inputFakes.getMimeType();
		}
		getPrimaryVideoTrack() {
			return inputFakes.getPrimaryVideoTrack();
		}
		getPrimaryAudioTrack() {
			return inputFakes.getPrimaryAudioTrack();
		}
		getDurationFromMetadata() {
			return inputFakes.getDurationFromMetadata();
		}
		dispose() {
			inputFakes.dispose();
		}
	}
	return { BlobSource, ALL_FORMATS, Input };
});

function videoTrack(overrides: Record<string, unknown> = {}) {
	return {
		getCodec: async () => 'avc',
		getCodecParameterString: async () => 'avc1.640028',
		codedWidth: 1280,
		codedHeight: 720,
		displayWidth: 1920,
		displayHeight: 1080,
		computeFrameRateMetrics: async () => ({
			underlyingFrameRate: 30,
			bestGuessFrameRate: 30,
			minFrameRate: 29.9,
			maxFrameRate: 30.1,
			averageFrameRate: 30
		}),
		getAverageBitrate: async () => 2_500_000,
		...overrides
	};
}

function audioTrack(overrides: Record<string, unknown> = {}) {
	return {
		getCodec: async () => 'aac',
		numberOfChannels: 2,
		getSampleRate: async () => 48_000,
		...overrides
	};
}

describe('probeVideoMetadata', () => {
	it('maps video + audio track data onto the metadata shape', async () => {
		inputFakes.getFormat.mockResolvedValue({ name: 'mp4' });
		inputFakes.getMimeType.mockResolvedValue('video/mp4');
		inputFakes.getPrimaryVideoTrack.mockResolvedValue(videoTrack());
		inputFakes.getPrimaryAudioTrack.mockResolvedValue(audioTrack());
		inputFakes.getDurationFromMetadata.mockResolvedValue(42.5);

		const meta = await probeVideoMetadata(new Blob(['x']));
		expect(meta).toMatchObject({
			container: 'mp4',
			mimeType: 'video/mp4',
			videoCodec: 'avc',
			codecParameter: 'avc1.640028',
			codedWidth: 1280,
			codedHeight: 720,
			displayWidth: 1920,
			displayHeight: 1080,
			averageBitrate: 2_500_000,
			durationSec: 42.5,
			audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 48_000 }
		});
		expect(meta.fps).toEqual({
			bestGuess: 30,
			underlying: 30,
			min: 29.9,
			max: 30.1,
			average: 30
		});
		expect(inputFakes.dispose).toHaveBeenCalled();
	});

	it('reports a VFR file with an underlying rate of null', async () => {
		inputFakes.getFormat.mockResolvedValue({ name: 'webm' });
		inputFakes.getMimeType.mockResolvedValue('video/webm');
		inputFakes.getPrimaryVideoTrack.mockResolvedValue(
			videoTrack({
				computeFrameRateMetrics: async () => ({
					underlyingFrameRate: null,
					bestGuessFrameRate: 29.5,
					minFrameRate: 12,
					maxFrameRate: 60,
					averageFrameRate: 29.5
				})
			})
		);
		inputFakes.getPrimaryAudioTrack.mockResolvedValue(null);
		inputFakes.getDurationFromMetadata.mockResolvedValue(10);

		const meta = await probeVideoMetadata(new Blob(['x']));
		expect(meta.container).toBe('webm');
		expect(meta.fps!.underlying).toBeNull();
		expect(meta.fps!.bestGuess).toBeCloseTo(29.5);
		expect(meta.audio).toBeNull();
	});

	it('throws on an unparseable container', async () => {
		inputFakes.getFormat.mockRejectedValue(new Error('Unrecognized format'));
		await expect(probeVideoMetadata(new Blob(['garbage']))).rejects.toThrow(/Unrecognized/);
	});
});