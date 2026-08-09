import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	acquireRcloneDriver,
	clearRcloneDriverCacheForTests,
	releaseRcloneDriver,
	rcloneDriverCacheSize,
	RCLONE_DRIVER_HOLD_MS
} from './rcloneDriverCache.js';
import { RcloneSimulator } from './rcloneSimulator.js';
import type { RcloneConnectionProfileV1 } from './types.js';

const profile = (id = 'p1'): RcloneConnectionProfileV1 => ({
	v: 1,
	id,
	name: 't',
	baseUrl: 'http://127.0.0.1:7750',
	fs: 'sim:',
	rcUser: 'u',
	rcPass: 'p',
	createdAt: 1,
	updatedAt: 1
});

describe('rcloneDriverCache', () => {
	beforeEach(() => {
		clearRcloneDriverCacheForTests();
		vi.useFakeTimers();
	});

	afterEach(() => {
		clearRcloneDriverCacheForTests();
		vi.useRealTimers();
	});

	it('reuses driver for same profile; release holds then disposes', async () => {
		const sim = new RcloneSimulator();
		const t = sim.transport();
		const d1 = await acquireRcloneDriver(profile(), { transport: t });
		const d2 = await acquireRcloneDriver(profile(), { transport: t });
		expect(d1).toBe(d2);
		expect(rcloneDriverCacheSize()).toBe(1);

		releaseRcloneDriver('p1');
		releaseRcloneDriver('p1');
		expect(rcloneDriverCacheSize()).toBe(1);
		vi.advanceTimersByTime(RCLONE_DRIVER_HOLD_MS + 1);
		expect(rcloneDriverCacheSize()).toBe(0);
	});

	it('concurrent acquires share create promise', async () => {
		const sim = new RcloneSimulator();
		const t = sim.transport();
		const [a, b] = await Promise.all([
			acquireRcloneDriver(profile('px'), { transport: t }),
			acquireRcloneDriver(profile('px'), { transport: t })
		]);
		expect(a).toBe(b);
		expect(rcloneDriverCacheSize()).toBe(1);
		releaseRcloneDriver('px');
		releaseRcloneDriver('px');
	});

	it('failed create clears cache entry', async () => {
		// Invalid rootPath throws during createRcloneExplorerDriver
		await expect(
			acquireRcloneDriver(
				{ ...profile('bad2'), rootPath: 'a/../b' },
				{ transport: new RcloneSimulator().transport() }
			)
		).rejects.toBeTruthy();
		expect(rcloneDriverCacheSize()).toBe(0);
	});

	it('auth fail on ready clears cache and rejects acquire', async () => {
		const sim = new RcloneSimulator();
		sim.authorized = false;
		await expect(
			acquireRcloneDriver(profile('auth-fail'), { transport: sim.transport() })
		).rejects.toMatchObject({ code: 'RCLONE_AUTH' });
		expect(rcloneDriverCacheSize()).toBe(0);
	});
});
