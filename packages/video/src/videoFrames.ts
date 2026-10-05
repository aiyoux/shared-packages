import { ALL_FORMATS, BlobSource, CanvasSink, Input, type CanvasSinkOptions, type WrappedCanvas } from 'mediabunny';

/** File-backed decoding; independent of playback, seeking and display refresh rate. */
export async function openVideoFrames(blob: Blob, options: CanvasSinkOptions = {}) {
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
			// CanvasSink applies the container's rotation and pixel aspect ratio,
			// matching the displayed source before the editor's own transform.
			sink: new CanvasSink(track, options),
			close: () => input.dispose()
		};
	} catch (error) {
		input.dispose();
		throw error;
	}
}

export type VideoFrameCursor = {
	/** Select the source frame covering localMs. Caller owns the returned frame. */
	pull(localMs: number): Promise<VideoFrame>;
	close(): void;
};

/**
 * Sequential decoding with one frame of lookahead. Repeated output samples
 * hold the current source frame; advancing selects by presentation timestamp,
 * including variable-rate sources. A backward pull restarts at that position.
 */
export async function openVideoFrameCursor(blob: Blob): Promise<VideoFrameCursor> {
	const decoded = await openVideoFrames(blob, { poolSize: 3 });
	let frames: AsyncGenerator<WrappedCanvas, void> | null = null;
	let current: WrappedCanvas | null = null;
	let next: WrappedCanvas | null = null;
	let lastTime = -Infinity;
	let closed = false;

	return {
		async pull(localMs) {
			if (closed) throw new Error('Video frame cursor is closed.');
			if (!Number.isFinite(localMs)) throw new Error('localMs must be finite');
			const time = Math.max(decoded.firstTimestamp, localMs / 1000);
			if (!frames || time < lastTime) {
				await frames?.return();
				current = await decoded.sink.getCanvas(time + decoded.timestampTolerance);
				if (!current) throw new Error('No video frame at the requested time.');
				frames = decoded.sink.canvases(current.timestamp);
				next = (await frames.next()).value ?? null;
			}
			// Respect the file's timestamp precision (WebM often uses milliseconds):
			// a 60 fps frame stored at 17 ms must still match the 16.667 ms grid.
			while (next && next.timestamp <= time + decoded.timestampTolerance) {
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
			decoded.close();
			current = next = null;
		}
	};
}
