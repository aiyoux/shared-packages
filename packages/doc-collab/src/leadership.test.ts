import { describe, expect, it, vi } from 'vitest';
import { roleForLeadership, watchLeadership, type Election } from './leadership.js';

function election(
	initial = false,
	decidedAtStart = initial
): Election & { grant: () => void; demote: () => void; decide: () => void } {
	let isLeader = initial;
	let decided = decidedAtStart;
	const listeners = new Set<() => void>();
	return {
		get isLeader() {
			return isLeader;
		},
		get decided() {
			return decided;
		},
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		yieldLeadership: vi.fn(),
		destroy: vi.fn(),
		decide() {
			decided = true;
			listeners.forEach((f) => f());
		},
		grant() {
			decided = true;
			isLeader = true;
			listeners.forEach((f) => f());
		},
		demote() {
			decided = true;
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
		watchLeadership(election(true), fn);
		expect(fn).toHaveBeenCalledWith(true);
	});

	it('says nothing while the lock has not answered', () => {
		const e = election(false, false);
		const fn = vi.fn();
		watchLeadership(e, fn);
		expect(fn).not.toHaveBeenCalled();
		e.grant();
		expect(fn).toHaveBeenCalledWith(true);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('reports "not leader" when the lock answers so, and not before', () => {
		const e = election(false, false);
		const fn = vi.fn();
		watchLeadership(e, fn);
		expect(fn).not.toHaveBeenCalled();
		e.decide();
		expect(fn).toHaveBeenCalledWith(false);
	});

	it('reports a real demotion after a grant', () => {
		const e = election(true);
		const fn = vi.fn();
		watchLeadership(e, fn);
		e.demote();
		expect(fn).toHaveBeenNthCalledWith(2, false);
	});

	it('goes quiet when stopped', () => {
		const e = election(false, false);
		const fn = vi.fn();
		watchLeadership(e, fn)();
		e.grant();
		expect(fn).not.toHaveBeenCalled();
	});
});
