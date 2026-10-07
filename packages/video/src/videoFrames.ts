import {
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	Input,
	VideoSampleSink,
	type CanvasSinkOptions,
	type VideoSample,
	type WrappedCanvas
} from 'mediabunny';

type OpenedVideo = {
	width: number;
	height: number;
	firstTimestamp: number;
	timestampTolerance: number;
	track: Awaited<ReturnType<Input['getPrimaryVideoTrack']>> & {};
	close: () => void;
};

async function openVideoSource(blob: Blob): Promise<OpenedVideo> {
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error('No video track in the source.');
		const [width, height, firstTimestamp, timeResolution] = await Promise.all([
			track.getDisplayWidth(), track.getDisplayHeight(), track.getFirstTimestamp(), track.getTimeResolution()
		]);
		return {
			width, height, firstTimestamp,
			timestampTolerance: 0.5 / timeResolution + 1e-7,
			track,
			close: () => input.dispose()
		};
	} catch (error) {
		input.dispose();
		throw error;
	}
}

/** File-backed decoding; independent of playback, seeking and display refresh rate. */
export async function openVideoFrames(blob: Blob, options: CanvasSinkOptions = {}) {
	const source = await openVideoSource(blob);
	try {
		return {
			width: source.width,
			height: source.height,
			firstTimestamp: source.firstTimestamp,
			timestampTolerance: source.timestampTolerance,
			// CanvasSink applies the container's rotation and pixel aspect ratio,
			// matching the displayed source before the editor's own transform.
			sink: new CanvasSink(source.track, options),
			close: source.close
		};
	} catch (error) {
		source.close();
		throw error;
	}
}

/**
 * Whether decoded frames equal displayed frames: no container rotation, square
 * pixels, and no alpha to flatten. Only then may a raw decoder frame skip the
 * canvas rasterization that CanvasSink (and the editor blit) otherwise apply.
 */
export function isDirectFrameSource(sample: Pick<VideoSample, 'rotation' | 'hasAlpha' | 'pixelAspectRatio'>): boolean {
	return (
		sample.rotation === 0 &&
		sample.hasAlpha === false &&
		sample.pixelAspectRatio.num === sample.pixelAspectRatio.den
	);
}

export type VideoFrameCursor = {
	/** Select the source frame covering localMs. Caller owns the returned frame. */
	pull(localMs: number): Promise<VideoFrame>;
	close(): void;
	/**
	 * Display size when frames arrive straight from the decoder
	 * (`isDirectFrameSource` held for the track); null when frames were
	 * rasterized through a canvas and must be treated as opaque pixels.
	 * Lets callers skip their own blit when they need no transform either.
	 */
	readonly directSize: { width: number; height: number } | null;
};

function canvasCursor(source: OpenedVideo): VideoFrameCursor {
	let sink: CanvasSink | null = new CanvasSink(source.track, { poolSize: 3 });
	let frames: AsyncGenerator<WrappedCanvas, void> | null = null;
	let current: WrappedCanvas | null = null;
	let next: WrappedCanvas | null = null;
	let lastTime = -Infinity;
	let closed = false;

	return {
		directSize: null,
		async pull(localMs) {
			if (closed || !sink) throw new Error('Video frame cursor is closed.');
			if (!Number.isFinite(localMs)) throw new Error('localMs must be finite');
			const time = Math.max(source.firstTimestamp, localMs / 1000);
			if (!frames || time < lastTime) {
				await frames?.return();
				current = await sink.getCanvas(time + source.timestampTolerance);
				if (!current) throw new Error('No video frame at the requested time.');
				frames = sink.canvases(current.timestamp);
				next = (await frames.next()).value ?? null;
			}
			// Respect the file's timestamp precision (WebM often uses milliseconds):
			// a 60 fps frame stored at 17 ms must still match the 16.667 ms grid.
			while (next && next.timestamp <= time + source.timestampTolerance) {
				current = next;
				next = (await frames.next()).value ?? null;
			}
			lastTime = time;
			return new VideoFrame(current!.canvas, {
				timestamp: Math.round(current!.timestamp * 1_000_000),
				duration: Math.max(1, Math.round(current!.duration * 1_000_000))
			});
		},
		close() {
			if (closed) return;
			closed = true;
			void frames?.return().catch(() => {});
			source.close();
			sink = null;
			current = next = null;
		}
	};
}

function sampleCursor(source: OpenedVideo): VideoFrameCursor {
	const sink = new VideoSampleSink(source.track);
	let frames: AsyncGenerator<VideoSample, void> | null = null;
	let current: VideoSample | null = null;
	let next: VideoSample | null = null;
	let lastTime = -Infinity;
	let closed = false;

	return {
		directSize: { width: source.width, height: source.height },
		async pull(localMs) {
			if (closed) throw new Error('Video frame cursor is closed.');
			if (!Number.isFinite(localMs)) throw new Error('localMs must be finite');
			const time = Math.max(source.firstTimestamp, localMs / 1000);
			if (!frames || time < lastTime) {
				await frames?.return();
				for (const stale of [current, next]) stale?.close();
				current = await sink.getSample(time + source.timestampTolerance);
				if (!current) throw new Error('No video frame at the requested time.');
				frames = sink.samples(current.timestamp);
				next = (await frames.next()).value ?? null;
			}
			while (next && next.timestamp <= time + source.timestampTolerance) {
				// The iterator restarts at the covering frame, so the first
				// `next` can be `current` itself — never close what we keep.
				if (next !== current) current?.close();
				current = next;
				next = (await frames.next()).value ?? null;
			}
			lastTime = time;
			// Kept open for repeated pulls at the same time; closed when the
			// cursor advances past it or closes. The returned frame has its
			// own lifetime and must be closed separately by the caller.
			return current!.toVideoFrame();
		},
		close() {
			if (closed) return;
			closed = true;
			void frames?.return().catch(() => {});
			for (const stale of [current, next]) stale?.close();
			source.close();
			current = next = null;
		}
	};
}

/**
 * Sequential decoding with one frame of lookahead. Repeated output samples
 * hold the current source frame; advancing selects by presentation timestamp,
 * including variable-rate sources. A backward pull restarts at that position.
 *
 * Tracks without rotation, pixel stretch, or alpha decode straight to
 * `VideoFrame`s (`directSize` set); anything else rasterizes through a canvas
 * exactly as before (`directSize` null).
 */
export async function openVideoFrameCursor(blob: Blob): Promise<VideoFrameCursor> {
	const source = await openVideoSource(blob);
	try {
		const probe = new VideoSampleSink(source.track);
		const head = await probe.getSample(source.firstTimestamp);
		try {
			if (head && isDirectFrameSource(head)) return sampleCursor(source);
			return canvasCursor(source);
		} finally {
			head?.close();
		}
	} catch (error) {
		source.close();
		throw error;
	}
}
