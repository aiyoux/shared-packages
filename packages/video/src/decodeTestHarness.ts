/** CanvasSink contract fixture: timed frames, canvas reuse, and decoder cleanup. */
export const decodeFixture = {
	frames: [] as Array<{ timestamp: number; duration: number; id: number }>,
	inputs: [] as Array<{ disposed: boolean }>,
	sinks: [] as Array<{ options: { poolSize?: number }; starts: number[]; returned: number }>,
	sampleSinks: [] as Array<{ starts: number[] }>,
	closedSamples: [] as number[],
	noTrack: false,
	timeResolution: 1_000_000,
	rotation: 0,
	pixelAspect: { num: 1, den: 1 },
	hasAlpha: false as boolean | null,
	error: null as Error | null,
	reset() {
		this.frames = [];
		this.inputs = [];
		this.sinks = [];
		this.sampleSinks = [];
		this.closedSamples = [];
		this.noTrack = false;
		this.timeResolution = 1_000_000;
		this.rotation = 0;
		this.pixelAspect = { num: 1, den: 1 };
		this.hasAlpha = false;
		this.error = null;
	}
};

export function decodeMock() {
	class Input {
		disposed = false;
		constructor(_options: unknown) { decodeFixture.inputs.push(this); }
		async getPrimaryVideoTrack() {
			if (decodeFixture.error) throw decodeFixture.error;
			return decodeFixture.noTrack ? null : {
				getDisplayWidth: async () => 640,
				getDisplayHeight: async () => 360,
				getTimeResolution: async () => decodeFixture.timeResolution,
				getFirstTimestamp: async () => decodeFixture.frames[0]?.timestamp ?? 0
			};
		}
		dispose() { this.disposed = true; }
	}
	class CanvasSink {
		starts: number[] = [];
		returned = 0;
		pool: Array<{ id: number }>;
		index = 0;
		constructor(_track: unknown, public options: { poolSize?: number }) {
			this.pool = Array.from({ length: options.poolSize ?? 0 }, () => ({ id: -1 }));
			decodeFixture.sinks.push(this);
		}
		wrap(frame: typeof decodeFixture.frames[number]) {
			const canvas = this.pool[this.index] ?? { id: -1 };
			this.index = (this.index + 1) % Math.max(1, this.pool.length);
			canvas.id = frame.id;
			return { canvas, timestamp: frame.timestamp, duration: frame.duration };
		}
		async getCanvas(time: number) {
			const frame = decodeFixture.frames.filter((f) => f.timestamp <= time).at(-1);
			return frame ? this.wrap(frame) : null;
		}
		async* canvases(start = 0, end = Infinity) {
			this.starts.push(start);
			try {
				for (const frame of decodeFixture.frames) {
					if (frame.timestamp >= start && frame.timestamp < end) {
						await Promise.resolve();
						yield this.wrap(frame);
					}
				}
			} finally { this.returned++; }
		}
	}
	class FakeSample {
		closed = false;
		constructor(public frame: typeof decodeFixture.frames[number]) {}
		get timestamp() { return this.frame.timestamp; }
		get duration() { return this.frame.duration; }
		get rotation() { return decodeFixture.rotation; }
		get pixelAspectRatio() { return decodeFixture.pixelAspect; }
		get hasAlpha() { return decodeFixture.hasAlpha; }
		toVideoFrame() {
			return {
				frameId: this.frame.id,
				timestamp: Math.round(this.frame.timestamp * 1_000_000),
				duration: Math.max(1, Math.round(this.frame.duration * 1_000_000)),
				closed: false,
				close(this: { closed: boolean }) { this.closed = true; }
			};
		}
		close() {
			if (!this.closed) decodeFixture.closedSamples.push(this.frame.id);
			this.closed = true;
		}
	}
	class VideoSampleSink {
		starts: number[] = [];
		constructor(_track: unknown) { decodeFixture.sampleSinks.push(this); }
		sampleAt(index: number) {
			const frame = decodeFixture.frames[index];
			return frame ? new FakeSample(frame) : null;
		}
		async getSample(time: number) {
			let best = -1;
			decodeFixture.frames.forEach((f, i) => { if (f.timestamp <= time) best = i; });
			return this.sampleAt(best);
		}
		async* samples(start = 0, end = Infinity) {
			this.starts.push(start);
			for (const [index, frame] of decodeFixture.frames.entries()) {
				if (frame.timestamp >= start && frame.timestamp < end) {
					await Promise.resolve();
					yield this.sampleAt(index)!;
				}
			}
		}
	}
	return { ALL_FORMATS: [], BlobSource: class { constructor(_blob: Blob) {} }, Input, CanvasSink, VideoSampleSink };
}
