import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	acquireMonitorDriver, retainMonitorDriver, releaseMonitorDriver,
	clearMonitorDriverCacheForTests, monitorDriverCacheSize, MONITOR_DRIVER_HOLD_MS
} from './monitorDriverCache.js';

const mock = vi.hoisted(() => ({ driver: { id: 'monitor', ready: vi.fn(async () => {}), dispose: vi.fn() } }));
vi.mock('./monitorExplorerDriver.js', () => ({ createMonitorExplorerDriver: vi.fn(async () => mock.driver) }));
vi.mock('./client.js', () => ({ createMonitorClient: vi.fn(() => ({})) }));
vi.mock('../services/monitorLink.js', () => ({ getMonitorLink: vi.fn() }));
vi.mock('./gitStream.js', () => ({ abortAllGitStreams: vi.fn(), abortGitStream: vi.fn() }));
vi.mock('./hostStream.js', () => ({ abortAllHostStreams: vi.fn(), abortHostStream: vi.fn() }));

describe('split monitor driver lifetime', () => {
	beforeEach(() => { vi.useFakeTimers(); clearMonitorDriverCacheForTests(); mock.driver.dispose.mockClear(); });
	afterEach(() => { clearMonitorDriverCacheForTests(); vi.useRealTimers(); });

	it('keeps the split connection alive after the original panel releases it', async () => {
		const profile = { v: 1 as const, id: 'split-monitor', name: 'Monitor',
			baseUrl: 'http://localhost:8300', rootPath: '/work', createdAt: 1, updatedAt: 1 };
		await acquireMonitorDriver(profile);
		retainMonitorDriver(profile.id);
		releaseMonitorDriver(profile.id);
		await vi.advanceTimersByTimeAsync(MONITOR_DRIVER_HOLD_MS + 1);
		expect(monitorDriverCacheSize()).toBe(1);
		expect(mock.driver.dispose).not.toHaveBeenCalled();
		releaseMonitorDriver(profile.id);
		await vi.advanceTimersByTimeAsync(MONITOR_DRIVER_HOLD_MS + 1);
		expect(monitorDriverCacheSize()).toBe(0);
		expect(mock.driver.dispose).toHaveBeenCalledTimes(1);
	});
});
