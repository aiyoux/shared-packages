import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planStreamCopy, trimStreamCopy } from './trimCopy.js';

/** Packet-level fixture: ordered decode-order packets with key flags. */
const packetFixture = {
	videoCodec: 'avc' as string | null,
	audioCodec: 'aac' as string | null,
	hasAudio: true,
	videoDecoderConfig: { codec: 'avc1.42E01F' } as unknown,
	audioDecoderConfig: { codec: 'mp4a.40.2' } as unknown,
	video: [] as Array<{ timestamp: number; duration: number; key: boolean }>,
	audio: [] as Array<{ timestamp: number; duration: number }>,
	adds: [] as Array<{ track: string; timestamp: number; meta: boolean }>,
	cancelled: false,
	finalized: false,
	reset() {
		this.videoCodec = 'avc';
		this.audioCodec = 'aac';
		this.hasAudio = true;
		this.video = [];
		this.audio = [];
		this.adds = [];
		this.cancelled = false;
		this.finalized = false;
	}
};

class FakePacket {
	constructor(
		public timestamp: number,
		public duration: number,
		public type: 'key' | 'delta'
	) {}
	clone(opts: { timestamp?: number }) {
		return new FakePacket(opts.timestamp ?? this.timestamp, this.duration, this.type);
	}
}

function keyIndexAtOrBefore(time: number): number {
	let best = -1;
	packetFixture.video.forEach((p, i) => {
		if (p.key && p.timestamp <= time + 1e-9) best = i;
	});
	return best;
}

vi.mock('mediabunny', () => {
	class BlobSource {
		constructor(_blob: Blob) {}
	}
	class FakeTrack {
		constructor(public kind: 'video' | 'audio') {}
		async getCodec() {
			return this.kind === 'video' ? packetFixture.videoCodec : packetFixture.audioCodec;
		}
		async getDecoderConfig() {
			return this.kind === 'video' ? packetFixture.videoDecoderConfig : packetFixture.audioDecoderConfig;
		}
	}
	class Input {
		constructor(_options: unknown) {}
		async getPrimaryVideoTrack() {
			return packetFixture.videoCodec ? new FakeTrack('video') : null;
		}
		async getPrimaryAudioTrack() {
			return packetFixture.hasAudio ? new FakeTrack('audio') : null;
		}
		dispose() {}
	}
	class EncodedPacketSink {
		constructor(public track: FakeTrack) {}
		packetAt(index: number) {
			const list = this.track.kind === 'video' ? packetFixture.video : packetFixture.audio;
			const p = list[index];
			if (!p) return null;
			return new FakePacket(p.timestamp, p.duration, 'key' in p && (p as { key: boolean }).key ? 'key' : 'delta');
		}
		async getKeyPacket(time: number) {
			const index = keyIndexAtOrBefore(time);
			return index >= 0 ? this.packetAt(index) : null;
		}
		async getPacket(time: number) {
			const list = this.track.kind === 'video' ? packetFixture.video : packetFixture.audio;
			let best = -1;
			list.forEach((p, i) => {
				if (p.timestamp <= time + 1e-9) best = i;
			});
			return best >= 0 ? this.packetAt(best) : null;
		}
		async getNextPacket(packet: FakePacket) {
			const list = this.track.kind === 'video' ? packetFixture.video : packetFixture.audio;
			const index = list.findIndex((p) => Math.abs(p.timestamp - packet.timestamp) < 1e-9);
			return this.packetAt(index + 1);
		}
	}
	class PacketSource {
		constructor(public track: string) {}
		async add(packet: FakePacket, meta?: unknown) {
			packetFixture.adds.push({ track: this.track, timestamp: packet.timestamp, meta: meta != null });
		}
	}
	class Output {
		target = { buffer: new Uint8Array([9, 9]).buffer };
		constructor(_options: unknown) {}
		addVideoTrack(_s: unknown) {}
		addAudioTrack(_s: unknown) {}
		async start() {}
		async finalize() {
			packetFixture.finalized = true;
		}
		async cancel() {
			packetFixture.cancelled = true;
		}
	}
	const format = {
		getSupportedVideoCodecs: () => ['avc', 'vp8', 'vp9'],
		getSupportedAudioCodecs: () => ['aac', 'opus', 'vorbis']
	};
	return {
		ALL_FORMATS: [],
		BlobSource,
		Input,
		EncodedPacketSink,
		EncodedVideoPacketSource: class extends PacketSource {
			constructor(_codec: unknown) {
				super('video');
			}
		},
		EncodedAudioPacketSource: class extends PacketSource {
			constructor(_codec: unknown) {
				super('audio');
			}
		},
		Output,
		BufferTarget: class {},
		Mp4OutputFormat: class {
			constructor(_o: unknown) {}
			getSupportedVideoCodecs() {
				return format.getSupportedVideoCodecs();
			}
			getSupportedAudioCodecs() {
				return format.getSupportedAudioCodecs();
			}
		},
		WebMOutputFormat: class {
			constructor() {}
			getSupportedVideoCodecs() {
				return format.getSupportedVideoCodecs();
			}
			getSupportedAudioCodecs() {
				return format.getSupportedAudioCodecs();
			}
		}
	};
});

beforeEach(() => packetFixture.reset());

describe('planStreamCopy', () => {
	it('accepts H.264 MP4 with AAC audio', () => {
		expect(planStreamCopy({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', audioIncluded: true })).toEqual({
			eligible: true,
			container: 'mp4',
			videoCodec: 'avc',
			audioCodec: 'aac'
		});
	});

	it('accepts VP9 WebM without audio', () => {
		const plan = planStreamCopy({ container: 'webm', videoCodec: 'vp9', audioCodec: null, audioIncluded: false });
		expect(plan).toEqual({ eligible: true, container: 'webm', videoCodec: 'vp9', audioCodec: null });
	});

	it('normalizes demuxer casing (MP4/WebM) before comparing', () => {
		expect(
			planStreamCopy({ container: 'MP4', videoCodec: 'AVC', audioCodec: 'AAC', audioIncluded: true })
		).toEqual({ eligible: true, container: 'mp4', videoCodec: 'avc', audioCodec: 'aac' });
	});

	it('rejects other containers and video codecs with reasons', () => {
		expect(planStreamCopy({ container: 'mov', videoCodec: 'avc', audioCodec: 'aac', audioIncluded: true }).eligible).toBe(false);
		expect(planStreamCopy({ container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac', audioIncluded: true })).toEqual({
			eligible: false,
			reason: expect.stringContaining('H.264')
		});
	});

	it('rejects uncopyable audio only when audio is included', () => {
		const withAudio = planStreamCopy({ container: 'mp4', videoCodec: 'avc', audioCodec: 'mp3', audioIncluded: true });
		expect(withAudio.eligible).toBe(false);
		const withoutAudio = planStreamCopy({ container: 'mp4', videoCodec: 'avc', audioCodec: 'mp3', audioIncluded: false });
		expect(withoutAudio).toEqual({ eligible: true, container: 'mp4', videoCodec: 'avc', audioCodec: null });
	});
});

describe('trimStreamCopy', () => {
	beforeEach(() => {
		// 1 fps, keyframes every 2 s — the trim 2.5–5 snaps back to 2.
		packetFixture.video = [0, 1, 2, 3, 4, 5, 6].map((t) => ({ timestamp: t, duration: 1, key: t % 2 === 0 }));
		packetFixture.audio = [0, 1, 2, 3, 4, 5, 6].map((t) => ({ timestamp: t, duration: 1 }));
	});

	it('snaps to the previous keyframe and rebases timestamps to zero', async () => {
		const result = await trimStreamCopy(new Blob(), { start: 2.5, end: 5, audio: true });
		expect(result.actualStart).toBe(2);
		expect(result.actualEnd).toBe(5);
		expect(result.audioCopied).toBe(true);
		expect(result.contentType).toBe('video/mp4');
		const video = packetFixture.adds.filter((a) => a.track === 'video').map((a) => a.timestamp);
		expect(video).toEqual([0, 1, 2]);
		const audio = packetFixture.adds.filter((a) => a.track === 'audio').map((a) => a.timestamp);
		expect(audio).toEqual([0, 1, 2]);
		// Decoder setup travels on the first packet of each track only.
		expect(packetFixture.adds.filter((a) => a.meta).map((a) => a.track)).toEqual(['video', 'audio']);
		expect(packetFixture.finalized).toBe(true);
	});

	it('keeps an in-range frame that arrives after a past-end packet in decode order', async () => {
		// B-frame-style reorder: 5.2 decodes before 4.9, both past/inside end=5.
		packetFixture.video = [
			{ timestamp: 4, duration: 0.5, key: true },
			{ timestamp: 5.2, duration: 0.5, key: false },
			{ timestamp: 4.9, duration: 0.3, key: false }
		];
		const result = await trimStreamCopy(new Blob(), { start: 4, end: 5, audio: false });
		expect(result.actualStart).toBe(4);
		expect(packetFixture.adds.map((a) => a.timestamp)).toEqual([0, 0.9]);
	});

	it('throws when no keyframe covers the trim start', async () => {
		packetFixture.video = [{ timestamp: 3, duration: 1, key: true }];
		await expect(trimStreamCopy(new Blob(), { start: 1, end: 2 })).rejects.toThrow(/keyframe/);
		expect(packetFixture.adds).toEqual([]);
		expect(packetFixture.finalized).toBe(false);
	});

	it('cancels the muxer when the range holds no packets', async () => {
		// Zero-duration key packet: the snap succeeds but nothing overlaps.
		packetFixture.video = [{ timestamp: 5, duration: 0, key: true }];
		await expect(trimStreamCopy(new Blob(), { start: 5, end: 6 })).rejects.toThrow(/no video packets/);
		expect(packetFixture.cancelled).toBe(true);
		expect(packetFixture.finalized).toBe(false);
	});

	it('throws on explicit audio copy with an uncopyable codec', async () => {
		packetFixture.audioCodec = 'mp3';
		await expect(trimStreamCopy(new Blob(), { start: 0, end: 2, audio: true })).rejects.toThrow(/cannot copy this audio/);
	});

	it('drops audio silently when copy was not explicitly requested', async () => {
		packetFixture.audioCodec = 'mp3';
		const result = await trimStreamCopy(new Blob(), { start: 0, end: 2 });
		expect(result.audioCopied).toBe(false);
		expect(packetFixture.adds.every((a) => a.track === 'video')).toBe(true);
	});

	it('aborts cleanly on an aborted signal', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(trimStreamCopy(new Blob(), { start: 0, end: 2, signal: controller.signal })).rejects.toThrow(/cancelled/i);
	});
});
