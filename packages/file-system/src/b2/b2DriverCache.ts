/**
 * Warm cache of authorized B2 explorer drivers keyed by profile id.
 *
 * Switching panes (or re-selecting the same profile) reuses an existing driver
 * instead of re-running b2_authorize_account. Drivers are held for a grace
 * period after the last pane stops using them so quick flicking doesn't thrash.
 */
import type { ExplorerDriver } from '../ui/explorerDriver.js';
import { createB2ExplorerDriver } from './b2ExplorerDriver.js';
import type { B2ConnectionProfileV1 } from './types.js';

/** Keep unused sessions warm so rapid connection switches don't re-auth. */
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

/** Drop every cached authorized B2 session (vault lock / tests). */
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
 * Get a warm driver for this profile (create + authorize if needed).
 * Call {@link releaseB2Driver} when a pane stops using it.
 */
export async function acquireB2Driver(profile: B2ConnectionProfileV1): Promise<ExplorerDriver> {
	const existing = cache.get(profile.id);
	if (existing?.driver) {
		cancelDispose(existing);
		existing.refs += 1;
		return existing.driver;
	}

	// Deduplicate concurrent first connects for the same profile
	if (existing?.creating) {
		const driver = await existing.creating;
		const e = cache.get(profile.id);
		if (e) {
			cancelDispose(e);
			e.refs += 1;
		}
		return driver;
	}

	const creating = createB2ExplorerDriver({ profile });
	cache.set(profile.id, {
		profileId: profile.id,
		driver: null as unknown as ExplorerDriver,
		refs: 0,
		disposeTimer: null,
		creating
	});

	try {
		const driver = await creating;
		const e = cache.get(profile.id);
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
		cache.delete(profile.id);
		throw err;
	}
}

/**
 * Pane no longer needs this profile. Driver stays warm for {@link B2_DRIVER_HOLD_MS}.
 */
export function releaseB2Driver(profileId: string | null | undefined): void {
	if (!profileId) return;
	const e = cache.get(profileId);
	if (!e) return;
	e.refs = Math.max(0, e.refs - 1);
	if (e.refs === 0) scheduleDispose(profileId);
}
