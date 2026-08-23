/**
 * Warm cache of monitor explorer drivers keyed by profile id.
 */
import type { ExplorerDriver } from '../ui/explorerDriver.js';
import { createMonitorClient } from './client.js';
import { abortAllGitStreams, abortGitStream } from './gitStream.js';
import { abortAllHostStreams, abortHostStream } from './hostStream.js';
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

/**
 * Dispose every cached driver when the page goes away.
 *
 * Without this, closing the tab (or navigating off the origin) leaves the
 * daemon's watch roots registered forever: it drops a root only on an explicit
 * DELETE, never on client disconnect, and the 5-minute idle-dispose timer dies
 * with the page before it can fire. Each browsed folder then costs a permanent
 * root until the daemon restarts, and at `max_roots` (16) every new
 * subscription fails — which surfaces later as "live updates stopped working"
 * with no obvious cause.
 *
 * `pagehide` (not `unload`) so this still runs when the browser puts the page
 * into the back/forward cache. The DELETEs are fire-and-forget; the transport
 * swallows failures, and a missed release is no worse than today's behaviour.
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
	window.addEventListener('pagehide', () => {
		for (const e of cache.values()) {
			if (e.disposeTimer) clearTimeout(e.disposeTimer);
			disposeEntry(e);
		}
		cache.clear();
		abortAllHostStreams();
		abortAllGitStreams();
	});
}

export function monitorDriverCacheSize(): number {
	return cache.size;
}

export function clearMonitorDriverCacheForTests(): void {
	for (const e of cache.values()) {
		if (e.disposeTimer) clearTimeout(e.disposeTimer);
		disposeEntry(e);
	}
	cache.clear();
	abortAllHostStreams();
	abortAllGitStreams();
}

function cancelDispose(e: CacheEntry) {
	if (e.disposeTimer) {
		clearTimeout(e.disposeTimer);
		e.disposeTimer = null;
	}
}

function abortProfileStreams(profileId: string) {
	abortHostStream(profileId);
	abortGitStream(profileId);
}

function disposeEntry(e: CacheEntry) {
	try {
		e.driver?.dispose?.();
	} catch {
		/* ignore */
	}
	abortProfileStreams(e.profileId);
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
