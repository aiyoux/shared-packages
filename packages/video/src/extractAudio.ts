import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	Input,
	Mp4OutputFormat,
	Output,
	WavOutputFormat,
	type AudioCodec
} from 'mediabunny';
import { openAudioChunks } from './audio.js';

export type AudioExtractContainer = 'm4a' | 'wav';

export type ExtractedAudio = {
	blob: Blob;
	container: AudioExtractContainer;
	/** Source codec when copied (`copied: true`), `'pcm-s16'` for the WAV fallback. */
	codec: string;
	/** True when the encoded packets were muxed as-is with no decode/re-encode. */
	copied: boolean;
	contentType: string;
};

const EXTRACT_MIME: Record<AudioExtractContainer, string> = {
	m4a: 'audio/mp4',
	wav: 'audio/wav'
};

/** Sibling name for an extracted-audio file next to the source video. */
export function suggestAudioExtractName(
	sourceName: string,
	container: AudioExtractContainer
): string {
	const base = sourceName.replace(/\.[^.]+$/, '') || 'audio';
	return `${base} (audio).${container}`;
}

/**
 * Extract the primary audio track of `blob` over `[startSec, endSec)`.
 *
 * Tries a bit-identical stream copy first: when the source codec is muxable
 * in MP4, encoded packets are piped straight into an audio-only MP4 (`.m4a`)
 * with timestamps rebased to zero — no decode, no re-encode. Otherwise falls
 * back to decoding via `openAudioChunks` and muxing 16-bit PCM WAV, which
 * always works. Throws when the source has no audio track.
 *
 * Copy cuts at packet boundaries, so the edges can be off by one packet
 * (~tens of ms); exact-sample trims go through the WAV path.
 */
export async function extractAudio(
	blob: Blob,
	opts: { startSec?: number; endSec?: number } = {}
): Promise<ExtractedAudio> {
	const startSec = Math.max(0, opts.startSec ?? 0);
	const endSec = Math.max(startSec, opts.endSec ?? Number.POSITIVE_INFINITY);
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) throw new Error('No audio track to extract');
		const codec = await track.getCodec();
		const mp4 = new Mp4OutputFormat();
		const copyable =
			!!codec && (mp4.getSupportedCodecs() as string[]).includes(codec);
		if (copyable) {
			return await copyTrack(input, codec as AudioCodec, startSec, endSec);
		}
		return await wavFallback(blob, startSec, endSec);
	} finally {
		input.dispose();
	}
}

async function copyTrack(
	input: Input,
	codec: AudioCodec,
	startSec: number,
	endSec: number
): Promise<ExtractedAudio> {
	const track = (await input.getPrimaryAudioTrack())!;
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
		target: new BufferTarget()
	});
	const source = new EncodedAudioPacketSource(codec);
	output.addAudioTrack(source);
	await output.start();
	const sink = new EncodedPacketSink(track);
	const decoderConfig = await track.getDecoderConfig();
	const from = startSec > 0 ? await sink.getPacket(startSec) : null;
	let first = true;
	let wrote = 0;
	try {
		for await (const packet of sink.packets(from ?? undefined)) {
			if (packet.timestamp >= endSec) break;
			const rebased = packet.clone({ timestamp: Math.max(0, packet.timestamp - startSec) });
			await source.add(
				rebased,
				first && decoderConfig ? { decoderConfig } : undefined
			);
			first = false;
			wrote++;
		}
	} finally {
		await output.finalize();
	}
	if (wrote === 0) throw new Error('No audio packets in the trimmed range');
	const buffer = (output.target as BufferTarget).buffer;
	return {
		blob: new Blob([buffer as BlobPart], { type: EXTRACT_MIME.m4a }),
		container: 'm4a',
		codec,
		copied: true,
		contentType: EXTRACT_MIME.m4a
	};
}

async function wavFallback(
	blob: Blob,
	startSec: number,
	endSec: number
): Promise<ExtractedAudio> {
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	const source = new AudioSampleSource({ codec: 'pcm-s16' });
	output.addAudioTrack(source);
	await output.start();
	let wrote = 0;
	try {
		for await (const chunk of openAudioChunks(blob, { startSec, endSec })) {
			const sample = new AudioSample({
				data: chunk.data,
				format: chunk.format,
				numberOfChannels: chunk.numberOfChannels,
				sampleRate: chunk.sampleRate,
				timestamp: chunk.timestamp
			});
			try {
				await source.add(sample);
				wrote++;
			} finally {
				sample.close();
			}
		}
	} finally {
		await output.finalize();
	}
	if (wrote === 0) throw new Error('No audio packets in the trimmed range');
	const buffer = (output.target as BufferTarget).buffer;
	return {
		blob: new Blob([buffer as BlobPart], { type: EXTRACT_MIME.wav }),
		container: 'wav',
		codec: 'pcm-s16',
		copied: false,
		contentType: EXTRACT_MIME.wav
	};
}
