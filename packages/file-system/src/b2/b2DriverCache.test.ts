import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	acquireB2Driver,
	releaseB2Driver,
	clearB2DriverCacheForTests,
	b2DriverCacheSize,
	B2_DRIVER_HOLD_MS
} from './b2DriverCache.js';
import type { B2ConnectionProfileV1 } from './types.js';

const PROFILE = (id: string): B2ConnectionProfileV1 => ({
	v: 1,
	id,
	name: id,
	applicationKeyId: 'k',
	applicationKey: 's',
	bucketName: 'bucket',
	createdAt: 1,
	updatedAt: 1
});

vi.mock('./b2ExplorerDriver.js', () => {
	let n = 0;
	return {
		createB2ExplorerDriver: vi.fn(async () => {
			n += 1;
			return {
				id: `driver-${n}`,
				capabilities: {},
				ready: async () => {},
				list: async () => ({ entries: [], truncated: false }),
				getPath: async () => [],
				delete: async () => {}
			};
		})
	};
});

import { createB2ExplorerDriver } from './b2ExplorerDriver.js';

describe('b2DriverCache', () => {
	beforeEach(() => {
		clearB2DriverCacheForTests();
		vi.mocked(createB2ExplorerDriver).mockClear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		clearB2DriverCacheForTests();
		vi.useRealTimers();
	});

	it('reuses driver for same profile without re-auth', async () => {
		const d1 = await acquireB2Driver(PROFILE('a'));
		const d2 = await acquireB2Driver(PROFILE('a'));
		expect(d1).toBe(d2);
		expect(createB2ExplorerDriver).toHaveBeenCalledTimes(1);
		releaseB2Driver('a');
		releaseB2Driver('a');
	});

	it('keeps driver warm after release until hold expires', async () => {
		await acquireB2Driver(PROFILE('a'));
		releaseB2Driver('a');
		expect(b2DriverCacheSize()).toBe(1);

		// Still warm — no re-create
		const d = await acquireB2Driver(PROFILE('a'));
		expect(d).toBeTruthy();
		expect(createB2ExplorerDriver).toHaveBeenCalledTimes(1);
		releaseB2Driver('a');

		vi.advanceTimersByTime(B2_DRIVER_HOLD_MS + 1);
		expect(b2DriverCacheSize()).toBe(0);

		await acquireB2Driver(PROFILE('a'));
		expect(createB2ExplorerDriver).toHaveBeenCalledTimes(2);
		releaseB2Driver('a');
	});

	it('does not dispose while another pane still holds a ref', async () => {
		await acquireB2Driver(PROFILE('a'));
		await acquireB2Driver(PROFILE('a'));
		releaseB2Driver('a');
		vi.advanceTimersByTime(B2_DRIVER_HOLD_MS + 1);
		expect(b2DriverCacheSize()).toBe(1);
		releaseB2Driver('a');
		vi.advanceTimersByTime(B2_DRIVER_HOLD_MS + 1);
		expect(b2DriverCacheSize()).toBe(0);
	});
});
