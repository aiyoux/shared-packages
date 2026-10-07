import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDirectFrameSource, openVideoFrameCursor } from './videoFrames.js';
import { decodeFixture } from './decodeTestHarness.js';
import { FakeVideoFrame, installCodecs } from './encodeTestHarness.js';

vi.mock('mediabunny', async () => (await import('./decodeTestHarness.js')).decodeMock());

let restore: () => void;
beforeEach(() => { decodeFixture.reset(); restore = installCodecs(); });
afterEach(() => restore());

describe('file-backed video cursor', () => {
	it('does not duplicate and skip frames when a 60 fps container rounds PTS to milliseconds', async () => {
		decodeFixture.timeResolution = 1000;
		decodeFixture.frames = Array.from({ length: 120 }, (_, id) => ({ id, timestamp: Math.round((id / 60) * 1000) / 1000, duration: 1 / 60 }));
		const cursor = await openVideoFrameCursor(new Blob());
		for (let i = 0; i < 120; i++) {
			const frame = await cursor.pull((i / 60) * 1000);
			expect((frame as unknown as FakeVideoFrame).frameId).toBe(i);
			frame.close();
		}
		cursor.close();
	});

	it('keeps every 60 fps source frame without needing DOM presentation', async () => {
		decodeFixture.frames = Array.from({ length: 120 }, (_, id) => ({ id, timestamp: id / 60, duration: 1 / 60 }));
		const cursor = await openVideoFrameCursor(new Blob());
		const ids: number[] = [];
		for (let i = 0; i < 120; i++) {
			const frame = await cursor.pull((i / 60) * 1000);
			ids.push((frame as unknown as FakeVideoFrame).frameId!);
			frame.close();
		}
		expect(ids).toEqual(Array.from({ length: 120 }, (_, i) => i));
		// Plain tracks decode straight to frames: a probe sink plus the
		// cursor sink, and no canvas sink at all.
		expect(decodeFixture.sinks).toHaveLength(0);
		expect(decodeFixture.sampleSinks).toHaveLength(2);
		expect(decodeFixture.sampleSinks[1]?.starts).toEqual([0]);
		expect(cursor.directSize).toEqual({ width: 640, height: 360 });
		cursor.close();
		expect(decodeFixture.inputs[0]?.disposed).toBe(true);
	});

	it('holds the covering VFR frame without letting the lookahead overwrite it', async () => {
		decodeFixture.frames = [
			{ id: 0, timestamp: 0, duration: 0.04 },
			{ id: 1, timestamp: 0.04, duration: 0.01 },
			{ id: 2, timestamp: 0.05, duration: 0.1 },
			{ id: 3, timestamp: 0.15, duration: 0.05 }
		];
		const cursor = await openVideoFrameCursor(new Blob());
		for (const [time, id] of [[20, 0], [30, 0], [40, 1], [50, 2], [100, 2], [150, 3]]) {
			const frame = await cursor.pull(time!);
			expect((frame as unknown as FakeVideoFrame).frameId).toBe(id);
			frame.close();
		}
		cursor.close();
	});

	it('starts inside a trimmed frame and restarts correctly on backward pulls', async () => {
		decodeFixture.frames = Array.from({ length: 10 }, (_, id) => ({ id, timestamp: id / 10, duration: 0.1 }));
		const cursor = await openVideoFrameCursor(new Blob());
		for (const [time, id] of [[350, 3], [650, 6], [250, 2]]) {
			const frame = await cursor.pull(time!);
			expect((frame as unknown as FakeVideoFrame).frameId).toBe(id);
			frame.close();
		}
		expect(decodeFixture.sampleSinks.at(-1)?.starts).toEqual([0.3, 0.2]);
		cursor.close();
		cursor.close();
		await expect(cursor.pull(0)).rejects.toThrow(/closed/);
	});

	it('disposes inputs when opening fails', async () => {
		decodeFixture.noTrack = true;
		await expect(openVideoFrameCursor(new Blob())).rejects.toThrow(/No video track/);
		expect(decodeFixture.inputs[0]?.disposed).toBe(true);
	});
});

describe('direct-decode decision', () => {
	it('decodes straight to frames on a plain track', async () => {
		decodeFixture.frames = Array.from({ length: 5 }, (_, id) => ({ id, timestamp: id / 10, duration: 0.1 }));
		const cursor = await openVideoFrameCursor(new Blob());
		expect(cursor.directSize).toEqual({ width: 640, height: 360 });
		// The probe sample sink plus the cursor's; no canvas sink exists.
		expect(decodeFixture.sampleSinks).toHaveLength(2);
		expect(decodeFixture.sinks).toEqual([]);
		cursor.close();
	});

	it.each([[90], [180], [270]])('rasterizes through a canvas when the container is rotated %d°', async (rotation) => {
		decodeFixture.rotation = rotation as 90 | 180 | 270;
		decodeFixture.frames = Array.from({ length: 5 }, (_, id) => ({ id, timestamp: id / 10, duration: 0.1 }));
		const cursor = await openVideoFrameCursor(new Blob());
		expect(cursor.directSize).toBeNull();
		// The probe still samples; the cursor is the only canvas sink.
		expect(decodeFixture.sinks).toHaveLength(1);
		expect(decodeFixture.sampleSinks).toHaveLength(1);
		cursor.close();
	});

	it('rasterizes through a canvas for pixel stretch or alpha', async () => {
		for (const variant of [
			{ pixelAspect: { num: 2, den: 1 } },
			{ hasAlpha: true }
		] as const) {
			decodeFixture.reset();
			decodeFixture.frames = Array.from({ length: 5 }, (_, id) => ({ id, timestamp: id / 10, duration: 0.1 }));
			Object.assign(decodeFixture, variant);
			const cursor = await openVideoFrameCursor(new Blob());
			expect(cursor.directSize, `directSize for ${JSON.stringify(variant)}`).toBeNull();
			expect(decodeFixture.sinks).toHaveLength(1);
			expect(decodeFixture.sampleSinks).toHaveLength(1);
			cursor.close();
		}
	});

	it('returns the frame id each pulled frame came from on the canvas path too', async () => {
		decodeFixture.rotation = 180;
		decodeFixture.frames = Array.from({ length: 5 }, (_, id) => ({ id, timestamp: id / 10, duration: 0.1 }));
		const cursor = await openVideoFrameCursor(new Blob());
		const ids: number[] = [];
		for (let i = 0; i < 5; i++) {
			const frame = await cursor.pull(i * 100);
			ids.push((frame as unknown as FakeVideoFrame).frameId!);
			frame.close();
		}
		expect(ids).toEqual([0, 1, 2, 3, 4]);
		cursor.close();
	});
});

describe('sample cursor lifetime', () => {
	it('closes the probe and superseded samples while holding the covering one', async () => {
		decodeFixture.frames = Array.from({ length: 5 }, (_, id) => ({ id, timestamp: id / 10, duration: 0.1 }));
		const cursor = await openVideoFrameCursor(new Blob());
		const f1 = await cursor.pull(0);
		// The probe discarded its head sample, opening closed the first
		// advance's superseded copy; the covering sample itself is held.
		expect(decodeFixture.closedSamples).toEqual([0, 0]);
		// The frame handed out is the caller's own: closing it does not touch
		// the cursor's kept sample, and a repeated pull must not close anything.
		const f2 = await cursor.pull(0);
		expect(decodeFixture.closedSamples).toEqual([0, 0]);
		expect(f2 as unknown).not.toBe(f1);
		f1.close();
		f2.close();

		await expect(cursor.pull(150)).resolves.toMatchObject({ timestamp: 100_000 });
		// Advancing past frame 0 closed exactly that one copy more.
		expect(decodeFixture.closedSamples).toEqual([0, 0, 0]);
		cursor.close();
		expect(decodeFixture.closedSamples).toEqual([0, 0, 0, 1, 2]);
		expect(decodeFixture.inputs[0]?.disposed).toBe(true);
	});

	it('closes stale samples when a backward pull restarts', async () => {
		decodeFixture.frames = Array.from({ length: 10 }, (_, id) => ({ id, timestamp: id / 10, duration: 0.1 }));
		const cursor = await openVideoFrameCursor(new Blob());
		await expect(cursor.pull(650)).resolves.toMatchObject({ timestamp: 600_000 });
		// The probe copy, then the restart's getSample copy of the covering
		// frame 6, superseded by the iterator's re-decode of the same frame.
		expect(decodeFixture.closedSamples).toEqual([0, 6]);
		await expect(cursor.pull(250)).resolves.toMatchObject({ timestamp: 200_000 });
		// The restart closed the held frame 6 and its lookahead 7, then the
		// frame-2 getSample copy in the same pattern as the first pull.
		expect(decodeFixture.closedSamples).toEqual([0, 6, 6, 7, 2]);
		cursor.close();
		// Holding frame 2 plus its lookahead 3 at close.
		expect(decodeFixture.closedSamples).toEqual([0, 6, 6, 7, 2, 2, 3]);
	});

	it('closes walked frames on a long forward pull and never decodes beyond the lookahead', async () => {
		decodeFixture.frames = Array.from({ length: 120 }, (_, id) => ({ id, timestamp: id / 60, duration: 1 / 60 }));
		const cursor = await openVideoFrameCursor(new Blob());
		(await cursor.pull(0)).close();
		(await cursor.pull(990)).close();
		// The walk closed every covering frame up to 58; frame 59 is held and
		// 60 is the lookahead. Frames 61+ are never decoded (not in the closed
		// set and not reachable), so no skipped frame leaks or burns work.
		const closed = decodeFixture.closedSamples;
		expect(closed[0]).toBe(0);
		expect(closed.at(-1)).toBe(58);
		expect(new Set(closed)).toEqual(new Set(Array.from({ length: 59 }, (_, i) => i)));
		expect(closed).toHaveLength(61);
		cursor.close();
		// Held frame 59 plus lookahead 60 at close.
		expect(decodeFixture.closedSamples).toHaveLength(63);
	});
});
