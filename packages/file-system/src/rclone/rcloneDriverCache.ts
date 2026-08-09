/**
 * Warm cache of rclone explorer drivers keyed by profile id.
 * Mirrors B2: 5m hold after last release; concurrent create shares promise.
 */
import type { ExplorerDriver } from '../ui/explorerDriver.js';
import { createRcloneExplorerDriver } from './rcloneExplorerDriver.js';
import { createRcClient, type RcloneProxyPaths } from './rcClient.js';
import type { RcloneTransport } from './rcloneSimulator.js';
import type { RcloneConnectionProfileV1 } from './types.js';

export const RCLONE_DRIVER_HOLD_MS = 5 * 60 * 1000;

type CacheEntry = {
	profileId: string;
	driver: ExplorerDriver;
	refs: number;
	disposeTimer: ReturnType<typeof setTimeout> | null;
	creating?: Promise<ExplorerDriver>;
};

const cache = new Map<string, CacheEntry>();

export function rcloneDriverCacheSize(): number {
	return cache.size;
}

export function clearRcloneDriverCacheForTests(): void {
	for (const e of cache.values()) {
		if (e.disposeTimer) clearTimeout(e.disposeTimer);
	}
	cache.clear();
}

function cancelDispose(e: CacheEntry) {
	if (e.disposeTimer) {
		clearTimeout(e.disposeTimer);
		e.disposeTimer = null;
	}
}

function scheduleDispose(profileId: string) {
	const e = cache.get(profileId);
	if (!e || e.refs > 0) return;
	cancelDispose(e);
	e.disposeTimer = setTimeout(() => {
		const cur = cache.get(profileId);
		if (!cur || cur.refs > 0) return;
		cache.delete(profileId);
	}, RCLONE_DRIVER_HOLD_MS);
}

export type AcquireRcloneDriverOptions = {
	/** Inject transport (tests / simulator). */
	transport?: RcloneTransport;
	proxyPaths?: RcloneProxyPaths;
};

/**
 * Get a warm driver for this profile (create if needed).
 * Production path builds transport via {@link createRcClient} (same-origin proxy).
 */
export async function acquireRcloneDriver(
	profile: RcloneConnectionProfileV1,
	opts?: AcquireRcloneDriverOptions
): Promise<ExplorerDriver> {
	const existing = cache.get(profile.id);
	if (existing?.driver) {
		cancelDispose(existing);
		existing.refs += 1;
		return existing.driver;
	}

	if (existing?.creating) {
		const driver = await existing.creating;
		const e = cache.get(profile.id);
		if (e) {
			cancelDispose(e);
			e.refs += 1;
		}
		return driver;
	}

	const transport =
		opts?.transport ??
		createRcClient({
			rcUser: profile.rcUser,
			rcPass: profile.rcPass,
			baseUrl: profile.baseUrl,
			proxyPaths: opts?.proxyPaths
		});

	const creating = createRcloneExplorerDriver({ profile, transport });
	cache.set(profile.id, {
		profileId: profile.id,
		driver: null as unknown as ExplorerDriver,
		refs: 0,
		disposeTimer: null,
		creating
	});

	try {
		const driver = await creating;
		// Probe RC auth/connectivity before advertising the driver to the UI.
		await driver.ready();
		const e = cache.get(profile.id);
		if (!e) return driver;
		e.driver = driver;
		e.creating = undefined;
		e.refs = 1;
		cancelDispose(e);
		return driver;
	} catch (err) {
		cache.delete(profile.id);
		throw err;
	}
}

export function releaseRcloneDriver(profileId: string | null | undefined): void {
	if (!profileId) return;
	const e = cache.get(profileId);
	if (!e) return;
	e.refs = Math.max(0, e.refs - 1);
	if (e.refs === 0) scheduleDispose(profileId);
}
