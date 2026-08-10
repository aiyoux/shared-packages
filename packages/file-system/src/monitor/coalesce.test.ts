import { describe, expect, it, vi } from 'vitest';
import { createCoalescer } from './coalesce.js';

describe('createCoalescer', () => {
	it('collapses a burst into one call', async () => {
		const fn = vi.fn();
		const c = createCoalescer(fn, { debounceMs: 30, maxDebounceMs: 500 });
		c.fire();
		c.fire();
		c.fire();
		expect(fn).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
	});

	it('fires during sustained churn instead of starving', async () => {
		const fn = vi.fn();
		const c = createCoalescer(fn, { debounceMs: 40, maxDebounceMs: 100 });

		// Calls closer together than debounceMs restart the timer every time; with
		// no ceiling this never fires while the storm runs.
		const storm = setInterval(() => c.fire(), 20);
		try {
			await vi.waitFor(() => expect(fn).toHaveBeenCalled(), { timeout: 400 });
		} finally {
			clearInterval(storm);
		}
	});

	it('cancel drops the pending call', async () => {
		const fn = vi.fn();
		const c = createCoalescer(fn, { debounceMs: 20 });
		c.fire();
		expect(c.pending()).toBe(true);
		c.cancel();
		expect(c.pending()).toBe(false);
		await new Promise((r) => setTimeout(r, 60));
		expect(fn).not.toHaveBeenCalled();
	});

	it('keeps the ceiling at or above the quiet period', async () => {
		// A ceiling below debounceMs would fire on every call — the opposite of
		// coalescing — so it is clamped up.
		const fn = vi.fn();
		const c = createCoalescer(fn, { debounceMs: 50, maxDebounceMs: 10 });
		c.fire();
		c.fire();
		await new Promise((r) => setTimeout(r, 20));
		expect(fn).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
	});
});
