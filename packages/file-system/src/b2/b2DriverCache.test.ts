import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	acquireB2Driver, retainB2Driver, releaseB2Driver, clearB2DriverCacheForTests,
	b2DriverCacheSize, B2_DRIVER_HOLD_MS
} from './b2DriverCache.js';
import type { B2ConnectionRow } from './types.js';

vi.mock('./monitorB2Driver.js', () => ({ createMonitorB2Driver: vi.fn(async () => ({ id: 'b2' })) }));

describe('split B2 driver lifetime', () => {
	beforeEach(() => { vi.useFakeTimers(); clearB2DriverCacheForTests(); });
	afterEach(() => { clearB2DriverCacheForTests(); vi.useRealTimers(); });

	it('keeps the cached connection until both split panels release it', async () => {
		const row = { rowId: 'split-b2' } as B2ConnectionRow;
		await acquireB2Driver(row);
		retainB2Driver(row.rowId);
		releaseB2Driver(row.rowId);
		await vi.advanceTimersByTimeAsync(B2_DRIVER_HOLD_MS + 1);
		expect(b2DriverCacheSize()).toBe(1);
		releaseB2Driver(row.rowId);
		await vi.advanceTimersByTimeAsync(B2_DRIVER_HOLD_MS + 1);
		expect(b2DriverCacheSize()).toBe(0);
	});
});
