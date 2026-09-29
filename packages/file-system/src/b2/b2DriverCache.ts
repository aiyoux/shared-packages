/**
 * Warm cache of monitor-backed B2 explorer drivers keyed by row id
 * (`${monitorProfileId}.${connectionId}`).
 *
 * Switching panes (or re-selecting the same connection) reuses an existing
 * driver instead of re-proving the connection. Drivers are held for a grace
 * period after the last pane stops using them so quick flicking doesn't thrash.
 */
import type { ExplorerDriver } from '../ui/explorerDriver.js';
import { createMonitorB2Driver } from './monitorB2Driver.js';
import type { B2ConnectionRow } from './types.js';

/** Keep unused drivers warm so rapid connection switches stay instant. */
export const B2_DRIVER_HOLD_MS = 5 * 60 * 1000;

type CacheEntry = {
	profileId: string;
	driver: ExplorerDriver;
	/** Panes currently bound to this driver */
	refs: number;
	disposeTimer: ReturnType<typeof setTimeout> | null;
	/** In-flight create for concurrent acquires of the same profile */
	creating?: Promise<ExplorerDriver>;
};

const cache = new Map<string, CacheEntry>();

/** Test / diagnostics */
export function b2DriverCacheSize(): number {
	return cache.size;
}

/** Drop every cached driver (connection list changed / tests). */
export function evictAllB2Drivers(): void {
	for (const e of cache.values()) {
		if (e.disposeTimer) clearTimeout(e.disposeTimer);
	}
	cache.clear();
}

export function clearB2DriverCacheForTests(): void {
	evictAllB2Drivers();
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
	}, B2_DRIVER_HOLD_MS);
}

/**
 * Get a warm driver for this connection (created on first use).
 * Call {@link releaseB2Driver} when a pane stops using it.
 */
export async function acquireB2Driver(row: B2ConnectionRow): Promise<ExplorerDriver> {
	const key = row.rowId;
	const existing = cache.get(key);
	if (existing?.driver) {
		cancelDispose(existing);
		existing.refs += 1;
		return existing.driver;
	}

	// Deduplicate concurrent first connects for the same profile
	if (existing?.creating) {
		const driver = await existing.creating;
		const e = cache.get(key);
		if (e) {
			cancelDispose(e);
			e.refs += 1;
		}
		return driver;
	}

	const creating = createMonitorB2Driver({ row });
	cache.set(key, {
		profileId: key,
		driver: null as unknown as ExplorerDriver,
		refs: 0,
		disposeTimer: null,
		creating
	});

	try {
		const driver = await creating;
		const e = cache.get(key);
		if (!e) {
			// Cleared mid-flight — still return driver (orphan; GC)
			return driver;
		}
		e.driver = driver;
		e.creating = undefined;
		e.refs = 1;
		cancelDispose(e);
		return driver;
	} catch (err) {
		cache.delete(key);
		throw err;
	}
}

/**
 * Pane no longer needs this row. Driver stays warm for {@link B2_DRIVER_HOLD_MS}.
 */
export function releaseB2Driver(profileId: string | null | undefined): void {
	if (!profileId) return;
	const e = cache.get(profileId);
	if (!e) return;
	e.refs = Math.max(0, e.refs - 1);
	if (e.refs === 0) scheduleDispose(profileId);
}
