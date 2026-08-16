import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompositionClock } from './clock.js';

let nowMs = 0;
let nextRafId = 1;
const pending = new Map<number, FrameRequestCallback>();

beforeEach(() => {
	nowMs = 0;
	nextRafId = 1;
	pending.clear();
	vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		const id = nextRafId++;
		pending.set(id, cb);
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => {
		pending.delete(id);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function advance(ms: number): void {
	nowMs += ms;
	const cbs = [...pending.values()];
	pending.clear();
	for (const cb of cbs) cb(nowMs);
}

describe('createCompositionClock', () => {
	it('seek while playing does not jump back', () => {
		const clock = createCompositionClock(10_000);
		clock.play();
		advance(250);
		expect(clock.get().timeMs).toBe(250);
		expect(clock.get().playing).toBe(true);

		clock.seek(4_000);
		expect(clock.get().timeMs).toBe(4_000);
		expect(clock.get().playing).toBe(true);

		advance(200);
		expect(clock.get().timeMs).toBe(4_200);
		expect(clock.get().playing).toBe(true);
		clock.dispose();
	});

	it('seek while paused only writes timeMs', () => {
		const clock = createCompositionClock(10_000);
		clock.seek(3_000);
		expect(clock.get()).toMatchObject({ timeMs: 3_000, playing: false });
		advance(500);
		expect(clock.get().timeMs).toBe(3_000);
		clock.dispose();
	});

	it('pauses at the end', () => {
		const clock = createCompositionClock(1_000);
		clock.play();
		advance(1_000);
		expect(clock.get()).toMatchObject({ timeMs: 1_000, playing: false });
		clock.dispose();
	});
});
