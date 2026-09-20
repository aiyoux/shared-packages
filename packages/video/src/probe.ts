import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

export type VideoFpsMetrics = {
	/** Best single-number frame rate for the file (never null; falls back to the average). */
	bestGuess: number;
	/** The underlying constant frame rate when the track is CFR, else null (VFR). */
	underlying: number | null;
	min: number;
	max: number;
	average: number;
};

export type VideoAudioMeta = {
	codec: string;
	numberOfChannels: number;
	sampleRate: number;
};

export type VideoMetadata = {
	/** Container/format name, e.g. "mp4", "webm". */
	container: string | null;
	mimeType: string | null;
	videoCodec: string | null;
	/** Codec parameter string when available, e.g. "avc1.640028". */
	codecParameter: string | null;
	codedWidth: number | null;
	codedHeight: number | null;
	displayWidth: number | null;
	displayHeight: number | null;
	fps: VideoFpsMetrics | null;
	averageBitrate: number | null;
	/** Duration from container metadata in seconds; null when the container omits it. */
	durationSec: number | null;
	audio: VideoAudioMeta | null;
};

/**
 * Probe a video blob's container-level metadata with mediabunny: real
 * codec/fps/bitrate values read from the file, not HTMLVideo presentation
 * approximations. Throws when the container can't be parsed — callers should
 * fall back to whatever the `<video>` element already told them.
 */
export async function probeVideoMetadata(blob: Blob): Promise<VideoMetadata> {
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	try {
		const [format, mimeType] = await Promise.all([input.getFormat(), input.getMimeType()]);

		const videoTrack = await input.getPrimaryVideoTrack();
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!videoTrack && !audioTrack) {
			throw new Error('No media tracks');
		}

		let video: Omit<
			VideoMetadata,
			| 'container'
			| 'mimeType'
			| 'audio'
			| 'durationSec'
			| 'averageBitrate'
		> | null = null;
		if (videoTrack) {
			const [codec, codecParameter] = await Promise.all([
				videoTrack.getCodec(),
				videoTrack.getCodecParameterString()
			]);
			const metrics = await videoTrack.computeFrameRateMetrics();
			const fps: VideoFpsMetrics = {
				underlying: metrics.underlyingFrameRate,
				min: metrics.minFrameRate,
				max: metrics.maxFrameRate,
				average: metrics.averageFrameRate,
				bestGuess: metrics.bestGuessFrameRate
			};
			video = {
				videoCodec: codec ?? null,
				codecParameter: codecParameter ?? null,
				codedWidth: videoTrack.codedWidth,
				codedHeight: videoTrack.codedHeight,
				displayWidth: videoTrack.displayWidth,
				displayHeight: videoTrack.displayHeight,
				fps
			};
		}

		let audio: VideoAudioMeta | null = null;
		if (audioTrack) {
			const codec = await audioTrack.getCodec();
			audio = {
				codec: codec ?? 'unknown',
				numberOfChannels: audioTrack.numberOfChannels,
				sampleRate: await audioTrack.getSampleRate()
			};
		}

		return {
			container: format?.name ?? null,
			mimeType: mimeType ?? null,
			durationSec: await input.getDurationFromMetadata(),
			averageBitrate: videoTrack ? await videoTrack.getAverageBitrate() : null,
			audio,
			...(video ?? {
				videoCodec: null,
				codecParameter: null,
				codedWidth: null,
				codedHeight: null,
				displayWidth: null,
				displayHeight: null,
				fps: null
			})
		};
	} finally {
		input.dispose();
	}
}