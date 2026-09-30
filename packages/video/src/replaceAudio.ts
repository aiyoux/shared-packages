/**
 * Put a new audio track under a video, copying the video stream untouched
 * (no decode, no re-encode). The browser counterpart of the monitor audio
 * tool's assemble stage: the upsampled mono PCM becomes an AAC track (Opus
 * where the browser has no AAC encoder), and the video packets are copied
 * as they are, rotation included.
 */
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	Mp4OutputFormat,
	Output,
	canEncodeAudio,
	type AudioCodec
} from 'mediabunny';

const REPLACE_AUDIO_BITRATE = 192_000;

/** Whether a media blob carries a video stream (audio-only files do not). */
export async function hasVideoStream(media: Blob): Promise<boolean> {
	const input = new Input({ source: new BlobSource(media), formats: ALL_FORMATS });
	try {
		return !!(await input.getPrimaryVideoTrack());
	} catch {
		return false;
	} finally {
		input.dispose();
	}
}

export async function replaceVideoAudio(
	video: Blob,
	pcm: Float32Array,
	sampleRate: number,
	opts: { signal?: AbortSignal; bitrate?: number } = {}
): Promise<Blob> {
	const bitrate = opts.bitrate ?? REPLACE_AUDIO_BITRATE;
	const shape = { numberOfChannels: 1, sampleRate, bitrate };
	let audioCodec: AudioCodec | null = null;
	for (const codec of ['aac', 'opus'] as const) {
		if (await canEncodeAudio(codec, shape).catch(() => false)) {
			audioCodec = codec;
			break;
		}
	}
	if (!audioCodec) throw new Error('This browser cannot encode AAC or Opus audio (WebCodecs).');

	const input = new Input({ source: new BlobSource(video), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track?.codec) throw new Error('The clip has no video stream this browser can copy.');
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
			target: new BufferTarget()
		});
		const videoSource = new EncodedVideoPacketSource(track.codec);
		output.addVideoTrack(videoSource, { rotation: await track.getRotation() });
		const audioSource = new AudioSampleSource({ codec: audioCodec, bitrate });
		output.addAudioTrack(audioSource);
		await output.start();
		try {
			const decoderConfig = await track.getDecoderConfig();
			let first = true;
			for await (const packet of new EncodedPacketSink(track).packets()) {
				opts.signal?.throwIfAborted();
				await videoSource.add(packet, first && decoderConfig ? { decoderConfig } : undefined);
				first = false;
			}
			// One-second samples keep the encoder queue short.
			for (let at = 0; at < pcm.length; at += sampleRate) {
				opts.signal?.throwIfAborted();
				const data = pcm.subarray(at, Math.min(pcm.length, at + sampleRate));
				const sample = new AudioSample({
					data,
					format: 'f32',
					numberOfChannels: 1,
					sampleRate,
					timestamp: at / sampleRate
				});
				await audioSource.add(sample);
				sample.close();
			}
			await output.finalize();
		} catch (err) {
			await output.cancel().catch(() => {});
			throw err;
		}
		const buffer = (output.target as BufferTarget).buffer;
		if (!buffer) throw new Error('The remux produced no bytes.');
		return new Blob([buffer], { type: 'video/mp4' });
	} finally {
		input.dispose();
	}
}
