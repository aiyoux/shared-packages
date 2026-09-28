/**
 * Audio-only encodes for the simple audio editor's format picker.
 *
 * WAV stays a hand-rolled PCM builder (hub `audioPeaks.encodeWavTrim`);
 * everything lossy goes through mediabunny here so the hub never imports
 * it directly. MP4/M4A carries AAC, Ogg carries Opus. MP3 is deliberately
 * absent: neither WebCodecs nor mediabunny encodes it.
 */
import {
	AudioSample,
	AudioSampleSource,
	BufferTarget,
	Mp4OutputFormat,
	OggOutputFormat,
	Output,
	type AudioCodec
} from 'mediabunny';
import type { RawAudioChunk } from './audio.js';

export type AudioOnlyFormat = 'm4a' | 'ogg';

const AUDIO_ONLY_CONTAINER: Record<AudioOnlyFormat, { mime: string; ext: string }> = {
	m4a: { mime: 'audio/mp4', ext: '.m4a' },
	ogg: { mime: 'audio/ogg', ext: '.ogg' }
};

const AUDIO_ONLY_CODEC: Record<AudioOnlyFormat, AudioCodec> = {
	m4a: 'aac',
	ogg: 'opus'
};

export function audioOnlyContainer(format: AudioOnlyFormat): { mime: string; ext: string } {
	return AUDIO_ONLY_CONTAINER[format];
}

/**
 * Mux + encode raw timeline chunks into one audio file. Chunk timestamps
 * are output-timeline seconds (retimed streams already are). Resolves to
 * the file bytes; throws on encoder or mux errors.
 */
export async function encodeAudioOnly(
	chunks: AsyncIterable<RawAudioChunk>,
	format: AudioOnlyFormat,
	opts: { bitrate?: number } = {}
): Promise<Uint8Array<ArrayBuffer>> {
	if (typeof AudioSample === 'undefined' || typeof Output === 'undefined') {
		throw new Error('Audio conversion requires WebCodecs audio encoding (modern Chromium).');
	}
	const target = new BufferTarget();
	const output = new Output({
		format:
			format === 'm4a'
				? new Mp4OutputFormat({ fastStart: 'in-memory' })
				: new OggOutputFormat(),
		target
	});
	const source = new AudioSampleSource({
		codec: AUDIO_ONLY_CODEC[format],
		bitrate: opts.bitrate ?? 128_000
	});
	output.addAudioTrack(source);
	const started = output.start();
	let seen = 0;
	await started;
	for await (const chunk of chunks) {
		const sample = new AudioSample({
			data: chunk.data,
			format: chunk.format,
			numberOfChannels: chunk.numberOfChannels,
			sampleRate: chunk.sampleRate,
			timestamp: chunk.timestamp
		});
		try {
			await source.add(sample);
		} finally {
			sample.close();
		}
		seen += 1;
	}
	if (seen === 0) throw new Error('No audio to convert');
	await output.finalize();
	const buffer = target.buffer;
	if (!buffer) throw new Error('Audio conversion produced no output');
	return new Uint8Array(buffer);
}
