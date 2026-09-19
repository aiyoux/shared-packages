import { describe, expect, it, vi } from 'vitest';
import { roleForLeadership, watchLeadership, type Election } from './leadership.js';

function election(initial = false): Election & { grant: () => void; demote: () => void } {
	let isLeader = initial;
	const listeners = new Set<() => void>();
	return {
		get isLeader() {
			return isLeader;
		},
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		yieldLeadership: vi.fn(),
		destroy: vi.fn(),
		grant() {
			isLeader = true;
			listeners.forEach((f) => f());
		},
		demote() {
			isLeader = false;
			listeners.forEach((f) => f());
		}
	};
}

describe('roleForLeadership', () => {
	it('maps the lock to a role', () => {
		expect(roleForLeadership(true)).toBe('sequencer');
		expect(roleForLeadership(false)).toBe('replica');
	});
});

describe('watchLeadership', () => {
	it('reports leadership at once when the lock is already held', () => {
		const fn = vi.fn();
		watchLeadership(election(true), fn, 50);
		expect(fn).toHaveBeenCalledWith(true);
	});

	it('does NOT guess "not leader" before the grace elapses', async () => {
		vi.useFakeTimers();
		const e = election(false);
		const fn = vi.fn();
		watchLeadership(e, fn, 250);
		expect(fn).not.toHaveBeenCalled();
		e.grant();
		expect(fn).toHaveBeenCalledWith(true);
		vi.advanceTimersByTime(300);
		expect(fn).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it('concludes "not leader" once the grace elapses with no grant', () => {
		vi.useFakeTimers();
		const fn = vi.fn();
		watchLeadership(election(false), fn, 250);
		vi.advanceTimersByTime(250);
		expect(fn).toHaveBeenCalledWith(false);
		vi.useRealTimers();
	});

	it('reports a real demotion after a grant', () => {
		const e = election(true);
		const fn = vi.fn();
		watchLeadership(e, fn, 50);
		e.demote();
		expect(fn).toHaveBeenNthCalledWith(2, false);
	});

	it('goes quiet when stopped', () => {
		const e = election(false);
		const fn = vi.fn();
		watchLeadership(e, fn, 50)();
		e.grant();
		expect(fn).not.toHaveBeenCalled();
	});
});
