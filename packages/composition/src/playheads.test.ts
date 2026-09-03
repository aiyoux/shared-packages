import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayheadRegistry } from './playheads.js';

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

describe('createPlayheadRegistry', () => {
	it('acquires the same clock for the same id and keeps independent clocks apart', () => {
		const reg = createPlayheadRegistry();
		const a1 = reg.acquire('primary', 10_000);
		const a2 = reg.acquire('primary', 10_000);
		const b = reg.acquire('alt', 10_000);
		expect(a1).toBe(a2);
		expect(a1).not.toBe(b);
		expect(reg.ids()).toEqual(['primary', 'alt']);

		a1.play();
		advance(1500);
		expect(a1.get().timeMs).toBe(1500);
		expect(a2.get().timeMs).toBe(1500);
		expect(b.get().timeMs).toBe(0);
	});

	it('disposes a clock when its last reference is released', () => {
		const reg = createPlayheadRegistry();
		const clock = reg.acquire('primary', 10_000);
		reg.release('primary');
		// Registry-level disposal: dropped and re-acquirable as a fresh clock.
		expect(reg.get('primary')).toBeUndefined();
		expect(reg.ids()).toEqual([]);
		const fresh = reg.acquire('primary', 10_000);
		expect(fresh).not.toBe(clock);
		expect(fresh.get().timeMs).toBe(0);
	});

	it('fans out duration changes to every clock', () => {
		const reg = createPlayheadRegistry();
		const a = reg.acquire('primary', 10_000);
		const b = reg.acquire('alt', 10_000);
		reg.setDurationAll(2000);
		expect(a.get().durationMs).toBe(2000);
		expect(b.get().durationMs).toBe(2000);
		reg.disposeAll();
		expect(reg.ids()).toEqual([]);
	});

	it('accepts a custom clock factory', () => {
		const created: number[] = [];
		const reg = createPlayheadRegistry({
			createClock: (durationMs) => {
				created.push(durationMs);
				return createTestClock(durationMs);
			}
		});
		reg.acquire('primary', 5000);
		expect(created).toEqual([5000]);
	});

	function createTestClock(durationMs: number) {
		let timeMs = 0;
		let playing = false;
		return {
			get: () => ({ timeMs, durationMs, playing, rate: 1 }),
			subscribe: () => () => {},
			play: () => {
				playing = true;
			},
			pause: () => {
				playing = false;
			},
			seek: (ms: number) => {
				timeMs = Math.min(Math.max(0, ms), durationMs);
			},
			setDuration: (ms: number) => {
				durationMs = ms;
			},
			setRate: () => {},
			dispose: () => {
				playing = false;
			}
		};
	}
});