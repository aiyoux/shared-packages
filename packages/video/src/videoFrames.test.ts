import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openVideoFrameCursor } from './videoFrames.js';
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
		expect(decodeFixture.sinks[0]?.starts).toEqual([0]);
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
		expect(decodeFixture.sinks[0]?.starts).toEqual([0.3, 0.2]);
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
