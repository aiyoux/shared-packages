/**
 * Warm cache of monitor explorer drivers keyed by profile id.
 */
import type { ExplorerDriver } from '../ui/explorerDriver.js';
import { createMonitorClient } from './client.js';
import { createMonitorExplorerDriver } from './monitorExplorerDriver.js';
import type { MonitorTransport } from './client.js';
import type { MonitorConnectionProfileV1 } from './types.js';

export const MONITOR_DRIVER_HOLD_MS = 5 * 60 * 1000;

type CacheEntry = {
	profileId: string;
	driver: ExplorerDriver;
	refs: number;
	disposeTimer: ReturnType<typeof setTimeout> | null;
	creating?: Promise<ExplorerDriver>;
};

const cache = new Map<string, CacheEntry>();

export function monitorDriverCacheSize(): number {
	return cache.size;
}

export function clearMonitorDriverCacheForTests(): void {
	for (const e of cache.values()) {
		if (e.disposeTimer) clearTimeout(e.disposeTimer);
		disposeEntry(e);
	}
	cache.clear();
}

function cancelDispose(e: CacheEntry) {
	if (e.disposeTimer) {
		clearTimeout(e.disposeTimer);
		e.disposeTimer = null;
	}
}

function disposeEntry(e: CacheEntry) {
	try {
		e.driver?.dispose?.();
	} catch {
		/* ignore */
	}
}

function scheduleDispose(profileId: string) {
	const e = cache.get(profileId);
	if (!e || e.refs > 0) return;
	cancelDispose(e);
	e.disposeTimer = setTimeout(() => {
		const cur = cache.get(profileId);
		if (!cur || cur.refs > 0) return;
		disposeEntry(cur);
		cache.delete(profileId);
	}, MONITOR_DRIVER_HOLD_MS);
}

export type AcquireMonitorDriverOptions = {
	transport?: MonitorTransport;
};

export async function acquireMonitorDriver(
	profile: MonitorConnectionProfileV1,
	opts?: AcquireMonitorDriverOptions
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

	const creating = (async () => {
		const transport =
			opts?.transport ??
			createMonitorClient({ baseUrl: profile.baseUrl });
		const driver = await createMonitorExplorerDriver({ profile, transport });
		await driver.ready();
		return driver;
	})();

	cache.set(profile.id, {
		profileId: profile.id,
		driver: null as unknown as ExplorerDriver,
		refs: 0,
		disposeTimer: null,
		creating
	});

	try {
		const driver = await creating;
		const e = cache.get(profile.id)!;
		e.driver = driver;
		e.creating = undefined;
		e.refs = 1;
		return driver;
	} catch (err) {
		cache.delete(profile.id);
		throw err;
	}
}

export function releaseMonitorDriver(profileId: string): void {
	const e = cache.get(profileId);
	if (!e) return;
	e.refs = Math.max(0, e.refs - 1);
	if (e.refs === 0) scheduleDispose(profileId);
}
