import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	createWaitTracker,
	REPORT_AFTER_MS,
	subscribeTabWaits,
	type TabWait
} from '../src/live/waits.ts';

/**
 * The tracker only decides when a wait is worth showing a person. These pin
 * that it shows once the oldest open wait is old enough, never for waits that
 * end in time, and clears exactly when the last one ends.
 */

let seen: TabWait[] = [];
let off: () => void = () => {};

beforeEach(() => {
	mock.timers.enable({ apis: ['setTimeout', 'Date'] });
	off = subscribeTabWaits((w) => (seen = w));
});

afterEach(() => {
	off();
	mock.timers.reset();
});

describe('createWaitTracker', () => {
	it('reports only after REPORT_AFTER_MS, and clears when the last wait ends', () => {
		let took = 0;
		const t = createWaitTracker('w1', () => ({ what: 'this page', takeOver: () => took++ }));
		const endA = t.begin();
		mock.timers.tick(REPORT_AFTER_MS - 1);
		assert.equal(seen.length, 0, 'not yet');
		const endB = t.begin();
		mock.timers.tick(1);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].id, 'w1');
		assert.equal(seen[0].what, 'this page');
		seen[0].takeOver?.();
		assert.equal(took, 1);
		endA();
		assert.equal(seen.length, 1, 'one wait still open');
		endB();
		endB();
		assert.equal(seen.length, 0, 'cleared by the last end, and ending twice is harmless');
	});

	it('a wait that ends in time never shows', () => {
		const t = createWaitTracker('w2', () => ({ what: 'x' }));
		const end = t.begin();
		mock.timers.tick(REPORT_AFTER_MS - 1);
		end();
		mock.timers.tick(REPORT_AFTER_MS * 2);
		assert.equal(seen.length, 0);
	});

	it('refresh re-describes a shown wait; dispose clears it', () => {
		let detail = 'first';
		const t = createWaitTracker('w3', () => ({ what: 'x', detail }));
		t.begin();
		mock.timers.tick(REPORT_AFTER_MS);
		assert.equal(seen[0].detail, 'first');
		detail = 'second';
		t.refresh();
		assert.equal(seen[0].detail, 'second');
		t.dispose();
		assert.equal(seen.length, 0);
	});

	it('does not report when disabled (no page to show it on)', () => {
		const t = createWaitTracker('w4', () => ({ what: 'x' }), { enabled: () => false });
		t.begin();
		mock.timers.tick(REPORT_AFTER_MS * 2);
		assert.equal(seen.length, 0);
	});
});
