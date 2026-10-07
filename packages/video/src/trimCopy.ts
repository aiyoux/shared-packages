import {
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	Mp4OutputFormat,
	Output,
	WebMOutputFormat,
	type AudioCodec,
	type EncodedPacket,
	type VideoCodec
} from 'mediabunny';

export type StreamCopyContainer = 'mp4' | 'webm';

/**
 * Well-trodden codec pairs for lossless trim: the bytes stay in their native
 * container, so every player that handled the source handles the output.
 * mediabunny's muxers accept more, but exotic pairs (HEVC, Opus-in-MP4) have
 * spotty player support and stay on the re-encode path.
 */
const COPYABLE_VIDEO: Record<StreamCopyContainer, readonly string[]> = {
	mp4: ['avc'],
	webm: ['vp8', 'vp9']
};

const COPYABLE_AUDIO: Record<StreamCopyContainer, readonly string[]> = {
	mp4: ['aac'],
	webm: ['opus', 'vorbis']
};

export type StreamCopyEligibility =
	| {
			eligible: true;
			container: StreamCopyContainer;
			videoCodec: VideoCodec;
			/** Null when the source has no audio track, or audio is excluded. */
			audioCodec: AudioCodec | null;
	  }
	| { eligible: false; reason: string };

/**
 * Decide synchronously from already-probed metadata whether a lossless
 * stream-copy trim is possible. No demux, no decode — safe to call on every
 * settings change to enable/disable the Fast-trim toggle.
 */
export function planStreamCopy(meta: {
	container: string | null;
	videoCodec: string | null;
	audioCodec: string | null;
	audioIncluded: boolean;
}): StreamCopyEligibility {
	// Container/codec names come from demuxer metadata ('MP4', 'WebM', …) —
	// normalize before comparing, and keep the raw value for messages.
	const containerName = meta.container?.toLowerCase() ?? null;
	const videoName = meta.videoCodec?.toLowerCase() ?? null;
	const audioName = meta.audioCodec?.toLowerCase() ?? null;
	const container = containerName === 'mp4' || containerName === 'webm' ? containerName : null;
	if (!container) {
		return {
			eligible: false,
			reason: `Fast trim needs an MP4 or WebM source (this is ${meta.container ?? 'unknown'}).`
		};
	}
	if (!videoName || !COPYABLE_VIDEO[container].includes(videoName)) {
		return {
			eligible: false,
			reason: `Fast trim needs ${container === 'mp4' ? 'H.264' : 'VP8/VP9'} video (this is ${meta.videoCodec ?? 'unknown'}).`
		};
	}
	if (meta.audioIncluded && audioName != null) {
		if (!COPYABLE_AUDIO[container].includes(audioName)) {
			return {
				eligible: false,
				reason: `Fast trim cannot copy this audio (${meta.audioCodec}) — exclude audio or use a full export.`
			};
		}
		return {
			eligible: true,
			container,
			videoCodec: videoName as VideoCodec,
			audioCodec: audioName as AudioCodec
		};
	}
	return { eligible: true, container, videoCodec: videoName as VideoCodec, audioCodec: null };
}

export type StreamCopyResult = {
	blob: Blob;
	contentType: string;
	/** Requested range. */
	start: number;
	end: number;
	/** Actual range: start snapped back to the previous keyframe. */
	actualStart: number;
	actualEnd: number;
	audioCopied: boolean;
};

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
}

/**
 * Lossless trim: demux the source, snap the start back to the previous
 * keyframe, and remux packets with rebased timestamps. No decode, no encode —
 * typically 10–100x faster than re-encoding, at identical quality.
 *
 * Cuts are keyframe-accurate, not frame-accurate: the output starts at the
 * nearest keyframe at or before `start` (reported as `actualStart`). Callers
 * must surface that so the user knows what happened.
 */
export async function trimStreamCopy(
	inputBlob: Blob,
	options: {
		start: number;
		end: number;
		/**
		 * `true` copies the audio track (throwing when its codec cannot be
		 * copied); `false` drops it. Omitted copies it when possible and
		 * silently produces video-only output otherwise.
		 */
		audio?: boolean;
		onProgress?: (n: number) => void;
		signal?: AbortSignal;
	}
): Promise<StreamCopyResult> {
	const { start, end } = options;
	if (!(end > start)) throw new Error('Trim end must be greater than trim start.');
	throwIfAborted(options.signal);

	const input = new Input({ source: new BlobSource(inputBlob), formats: ALL_FORMATS });
	try {
		const [videoTrack, audioTrack] = await Promise.all([
			input.getPrimaryVideoTrack(),
			options.audio === false ? Promise.resolve(null) : input.getPrimaryAudioTrack()
		]);
		if (!videoTrack) throw new Error('No video track in the source.');
		const [videoCodec, audioCodec] = await Promise.all([
			videoTrack.getCodec(),
			audioTrack?.getCodec() ?? Promise.resolve(null)
		]);

		// Re-validate at export time: the file on disk wins over probed metadata.
		const container: StreamCopyContainer | null =
			videoCodec === 'avc' ? 'mp4' : videoCodec === 'vp8' || videoCodec === 'vp9' ? 'webm' : null;
		if (!container || !COPYABLE_VIDEO[container].includes(videoCodec!)) {
			throw new Error(`Fast trim needs H.264 MP4 or VP8/VP9 WebM (this is ${videoCodec ?? 'unknown'}).`);
		}
		let audioSource: EncodedAudioPacketSource | null = null;
		let audioSink: EncodedPacketSink | null = null;
		let audioDecoderConfig: AudioDecoderConfig | null = null;
		if (audioTrack) {
			if (audioCodec && COPYABLE_AUDIO[container].includes(audioCodec)) {
				audioSource = new EncodedAudioPacketSource(audioCodec as AudioCodec);
				audioSink = new EncodedPacketSink(audioTrack);
				audioDecoderConfig = await audioTrack.getDecoderConfig();
			} else if (options.audio === true) {
				throw new Error(`Fast trim cannot copy this audio (${audioCodec ?? 'unknown'}) — exclude audio or use a full export.`);
			}
		}

		const videoSink = new EncodedPacketSink(videoTrack);
		const [videoDecoderConfig, firstKey] = await Promise.all([
			videoTrack.getDecoderConfig(),
			videoSink.getKeyPacket(start, { verifyKeyPackets: true })
		]);
		if (!videoDecoderConfig) throw new Error('Fast trim cannot read this file (missing decoder setup).');
		if (!firstKey) throw new Error('Fast trim found no keyframe at or before the trim start.');
		const actualStart = Math.max(0, firstKey.timestamp);
		if (actualStart >= end) throw new Error('Fast trim found no keyframe inside the trim range.');

		const format = container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat();
		if (
			!format.getSupportedVideoCodecs().includes(videoCodec as VideoCodec) &&
			!format.getSupportedAudioCodecs().includes(videoCodec as AudioCodec)
		) {
			throw new Error(`Fast trim cannot mux ${videoCodec} into ${container}.`);
		}
		const output = new Output({ format, target: new BufferTarget() });
		const videoSource = new EncodedVideoPacketSource(videoCodec as VideoCodec);
		output.addVideoTrack(videoSource);
		if (audioSource) output.addAudioTrack(audioSource);
		let finalized = false;
		try {
			await output.start();
			throwIfAborted(options.signal);

			// One chain for every mux add keeps packet order deterministic.
			let chain = Promise.resolve();
			const copied = { video: 0, audio: 0 };
			let videoMetaSent = false;
			let audioMetaSent = false;
			const report = (time: number) =>
				options.onProgress?.(Math.min(100, Math.max(0, Math.round(((time - actualStart) / (end - actualStart)) * 100))));

			// Decode-order walks, keeping packets whose presentation interval
			// overlaps [actualStart, end). The stop edge sits past `end`
			// because B-frames arrive in decode order — timestamps can step
			// back locally, so stopping at the first packet past `end`
			// would drop frames that belong to the range.
			const STOP_PAST_END_SEC = 5;
			const keepPacket = (timestamp: number, duration: number): boolean => {
				const packetEnd = timestamp + Math.max(0, duration);
				return packetEnd > actualStart && timestamp < end;
			};
			// Microsecond grid, like the re-encode paths: rebasing in float
			// seconds would bake dust (4.9 − 4 = 0.9000000000000004) into
			// every output PTS.
			const rebase = (timestamp: number) => Math.max(0, Math.round((timestamp - actualStart) * 1_000_000) / 1_000_000);
			for (let packet: EncodedPacket | null = firstKey; packet; packet = await videoSink.getNextPacket(packet)) {
				throwIfAborted(options.signal);
				if (packet.timestamp > end + STOP_PAST_END_SEC) break;
				if (!keepPacket(packet.timestamp, packet.duration)) continue;
				const rebased = packet.clone({ timestamp: rebase(packet.timestamp) });
				const meta = videoMetaSent ? undefined : { decoderConfig: videoDecoderConfig };
				videoMetaSent = true;
				chain = chain.then(() => videoSource.add(rebased, meta));
				copied.video++;
				if (copied.video % 64 === 0) {
					await chain;
					report(packet.timestamp);
				}
			}
			// Audio: same window, rebased onto the same zero-based timeline.
			if (audioSink && audioSource && audioDecoderConfig) {
				const first = await audioSink.getPacket(actualStart);
				for (let packet: EncodedPacket | null = first; packet; packet = await audioSink.getNextPacket(packet)) {
					throwIfAborted(options.signal);
					if (packet.timestamp > end + STOP_PAST_END_SEC) break;
					if (!keepPacket(packet.timestamp, packet.duration)) continue;
					const rebased = packet.clone({ timestamp: rebase(packet.timestamp) });
					const meta = audioMetaSent ? undefined : { decoderConfig: audioDecoderConfig };
					audioMetaSent = true;
					chain = chain.then(() => audioSource!.add(rebased, meta));
					copied.audio++;
					if (copied.audio % 128 === 0) await chain;
				}
			}
			if (copied.video === 0) throw new Error('Fast trim found no video packets in the trim range.');
			await chain;
			await output.finalize();
			finalized = true;
			const buffer = (output.target as BufferTarget).buffer;
			if (!buffer) throw new Error('Muxing produced no output buffer.');
			report(end);
			const contentType = container === 'mp4' ? 'video/mp4' : 'video/webm';
			return {
				blob: new Blob([buffer], { type: contentType }),
				contentType,
				start,
				end,
				actualStart,
				actualEnd: end,
				audioCopied: copied.audio > 0
			};
		} finally {
			if (!finalized) await output.cancel().catch(() => {});
		}
	} finally {
		input.dispose();
	}
}
