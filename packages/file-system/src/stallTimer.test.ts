import { describe, expect, it, vi } from 'vitest';
import { createStallTimer, StallError } from './stallTimer.js';

describe('createStallTimer', () => {
	it('aborts only after the window passes with no bumps', async () => {
		vi.useFakeTimers();
		const stall = createStallTimer(1000);
		const fired: unknown[] = [];
		stall.signal.addEventListener('abort', () => fired.push(stall.signal.reason));
		vi.advanceTimersByTime(999);
		expect(fired).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(stall.signal.aborted).toBe(true);
		expect(stall.signal.reason).toBeInstanceOf(StallError);
		vi.useRealTimers();
		stall.dispose();
	});

	it('a bump restarts the window — an active transfer is never cut', async () => {
		vi.useFakeTimers();
		const stall = createStallTimer(1000);
		const fired: unknown[] = [];
		stall.signal.addEventListener('abort', () => fired.push(1));
		// Tick every 900ms, forever: never quiet for the full window.
		for (let i = 0; i < 20; i++) {
			vi.advanceTimersByTime(900);
			stall.bump();
		}
		expect(fired).toEqual([]);
		vi.useRealTimers();
		stall.dispose();
	});

	it('dispose stops the timer without aborting', async () => {
		vi.useFakeTimers();
		const stall = createStallTimer(1000);
		stall.dispose();
		vi.advanceTimersByTime(10_000);
		expect(stall.signal.aborted).toBe(false);
		vi.useRealTimers();
	});

	it('composes the outer abort signal', async () => {
		const outer = new AbortController();
		const stall = createStallTimer(60_000, outer.signal);
		outer.abort('user-cancelled');
		expect(stall.signal.aborted).toBe(true);
		expect(stall.signal.reason).toBe(outer.signal.reason);
		stall.dispose();
	});

	it('mirrors an already-aborted outer signal', () => {
		const outer = new AbortController();
		outer.abort();
		const stall = createStallTimer(60_000, outer.signal);
		expect(stall.signal.aborted).toBe(true);
		stall.dispose();
	});

	it('stallMs <= 0 disables the window but still mirrors outer aborts', async () => {
		vi.useFakeTimers();
		const outer = new AbortController();
		const stall = createStallTimer(0, outer.signal);
		vi.advanceTimersByTime(10_000_000);
		expect(stall.signal.aborted).toBe(false);
		outer.abort();
		expect(stall.signal.aborted).toBe(true);
		vi.useRealTimers();
	});
});