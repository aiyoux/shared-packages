import { afterEach, describe, expect, it, vi } from 'vitest';
import { avcLevelByte, createEncodeSession, parseBitrate } from './encodeSession.js';
import { processVideo } from './process.js';

vi.mock('mediabunny', () => {
	class BufferTarget {
		buffer: ArrayBuffer | null = null;
	}
	class Mp4OutputFormat {
		constructor(_opts?: unknown) {}
	}
	class EncodedVideoPacketSource {
		async add() {}
	}
	class EncodedPacket {
		static fromEncodedChunk(chunk: unknown) {
			return { chunk };
		}
	}
	class Output {
		target: BufferTarget;
		constructor(opts: { target: BufferTarget }) {
			this.target = opts.target;
		}
		addVideoTrack() {}
		async start() {}
		async finalize() {
			this.target.buffer = new Uint8Array([1, 2, 3, 4]).buffer;
		}
	}
	return { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket };
});

type EncodeCall = { timestamp: number; keyFrame?: boolean };

class FakeVideoFrame {
	timestamp: number;
	closed = false;
	constructor(_source?: unknown, init?: { timestamp?: number }) {
		this.timestamp = init?.timestamp ?? 0;
	}
	close() {
		this.closed = true;
	}
}

class FakeVideoEncoder {
	static instances: FakeVideoEncoder[] = [];
	static reset() {
		FakeVideoEncoder.instances = [];
	}

	configureCalls: VideoEncoderConfig[] = [];
	encodeCalls: EncodeCall[] = [];
	flushCount = 0;
	closeCount = 0;

	constructor(private init: VideoEncoderInit) {
		FakeVideoEncoder.instances.push(this);
	}

	configure(config: VideoEncoderConfig) {
		this.configureCalls.push(config);
	}

	encode(frame: { timestamp: number }, opts?: { keyFrame?: boolean }) {
		this.encodeCalls.push({ timestamp: frame.timestamp, keyFrame: opts?.keyFrame });
		const data = new Uint8Array([0, 0, 0, 1]);
		this.init.output(
			{
				type: opts?.keyFrame ? 'key' : 'delta',
				timestamp: frame.timestamp,
				duration: 33_333,
				byteLength: data.byteLength,
				copyTo(dest: BufferSource) {
					new Uint8Array(dest as ArrayBuffer).set(data);
				}
			} as EncodedVideoChunk,
			{ decoderConfig: { codec: 'avc1.42E01F' } }
		);
	}

	async flush() {
		this.flushCount += 1;
	}

	close() {
		this.closeCount += 1;
	}
}

function installCodecs() {
	const prevEnc = globalThis.VideoEncoder;
	const prevFrame = globalThis.VideoFrame;
	FakeVideoEncoder.reset();
	globalThis.VideoEncoder = FakeVideoEncoder as unknown as typeof VideoEncoder;
	globalThis.VideoFrame = FakeVideoFrame as unknown as typeof VideoFrame;
	return () => {
		globalThis.VideoEncoder = prevEnc;
		globalThis.VideoFrame = prevFrame;
		FakeVideoEncoder.reset();
	};
}

function frame(timestamp: number): VideoFrame {
	return new FakeVideoFrame(undefined, { timestamp }) as unknown as VideoFrame;
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 1000) {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 0));
	}
}

function installProcessVideoDom() {
	const currentTimeSets: number[] = [];
	const rvfc: Array<(now: number, meta: { mediaTime: number }) => void> = [];
	const play = vi.fn(() => Promise.resolve());
	let currentTime = 0;
	let src = '';
	const seeked = new Set<() => void>();
	const ended = new Set<() => void>();

	const video = {
		muted: false,
		playsInline: false,
		preload: '',
		ended: false,
		paused: true,
		videoWidth: 640,
		videoHeight: 360,
		style: {} as Record<string, string>,
		onloadedmetadata: null as null | (() => void),
		onerror: null as null | (() => void),
		get src() {
			return src;
		},
		set src(v: string) {
			src = v;
			queueMicrotask(() => this.onloadedmetadata?.());
		},
		get currentTime() {
			return currentTime;
		},
		set currentTime(v: number) {
			currentTime = v;
			currentTimeSets.push(v);
			for (const fn of [...seeked]) fn();
		},
		addEventListener(type: string, fn: () => void) {
			if (type === 'seeked') seeked.add(fn);
			if (type === 'ended') ended.add(fn);
		},
		removeEventListener(type: string, fn: () => void) {
			seeked.delete(fn);
			ended.delete(fn);
		},
		requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number }) => void) {
			rvfc.push(cb);
			return rvfc.length;
		},
		play() {
			this.paused = false;
			return play();
		},
		pause() {
			this.paused = true;
		}
	};

	const host = {
		style: {} as Record<string, string>,
		appendChild: vi.fn(),
		parentNode: { removeChild: vi.fn() }
	};

	const prevDoc = globalThis.document;
	const prevURL = globalThis.URL;

	globalThis.document = {
		createElement(tag: string) {
			if (tag === 'video') return video;
			return host;
		},
		body: { appendChild: vi.fn() }
	} as unknown as Document;

	globalThis.URL = {
		createObjectURL: () => 'blob:fake-video',
		revokeObjectURL: () => {}
	} as unknown as typeof URL;

	function deliver(mediaTime: number) {
		const cb = rvfc.shift();
		if (!cb) throw new Error('no pending requestVideoFrameCallback');
		cb(0, { mediaTime });
	}

	function restore() {
		globalThis.document = prevDoc;
		globalThis.URL = prevURL;
	}

	return { play, rvfc, currentTimeSets, deliver, restore };
}

let restoreCodecs: (() => void) | undefined;
let restoreDom: (() => void) | undefined;

afterEach(() => {
	restoreCodecs?.();
	restoreCodecs = undefined;
	restoreDom?.();
	restoreDom = undefined;
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

describe('processVideo capture model', () => {
	it('plays and uses RVFC mediaTime; does not seek currentTime per frame', async () => {
		restoreCodecs = installCodecs();
		const dom = installProcessVideoDom();
		restoreDom = dom.restore;

		const done = processVideo(new Blob(['x'], { type: 'video/mp4' }), {
			start: 1,
			end: 1.1,
			bitrate: '1M'
		});

		await waitFor(() => dom.play.mock.calls.length > 0, 'video.play');
		expect(dom.rvfc.length).toBeGreaterThan(0);
		expect(dom.play).toHaveBeenCalledTimes(1);
		expect(dom.currentTimeSets).toEqual([1]);

		dom.deliver(0.9);
		dom.deliver(1.0);
		dom.deliver(1.033);
		dom.deliver(1.066);
		dom.deliver(1.2);

		const blob = await done;
		expect(blob.type).toBe('video/mp4');
		expect(dom.play).toHaveBeenCalledTimes(1);
		expect(dom.currentTimeSets).toEqual([1]);

		const enc = FakeVideoEncoder.instances[0]!;
		expect(enc.encodeCalls.map((c) => c.timestamp)).toEqual([0, 33_000, 66_000]);
		expect(enc.encodeCalls[0]?.keyFrame).toBe(true);
	});
});
