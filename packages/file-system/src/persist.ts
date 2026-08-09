/**
 * Request persistent origin storage so IndexedDB + OPFS are less likely to be
 * evicted under disk pressure. Best-effort: denial is not fatal.
 */

export type PersistenceStatus = 'persistent' | 'best-effort' | 'unsupported';

export interface PersistenceResult {
	status: PersistenceStatus;
	/** True if we invoked persist() this call (vs already persisted / unsupported). */
	requested: boolean;
	/** Last known estimate after check (bytes). */
	usage?: number;
	quota?: number;
}

/**
 * Ensure this origin has requested persistent storage.
 * Safe to call repeatedly; checks `persisted()` first.
 */
export async function ensurePersistentStorage(): Promise<PersistenceResult> {
	if (typeof navigator === 'undefined' || !navigator.storage) {
		return { status: 'unsupported', requested: false };
	}

	const storage = navigator.storage;
	let usage: number | undefined;
	let quota: number | undefined;
	try {
		if (typeof storage.estimate === 'function') {
			const est = await storage.estimate();
			usage = est.usage;
			quota = est.quota;
		}
	} catch {
		/* ignore estimate failures */
	}

	if (typeof storage.persisted !== 'function' || typeof storage.persist !== 'function') {
		return { status: 'unsupported', requested: false, usage, quota };
	}

	try {
		if (await storage.persisted()) {
			return { status: 'persistent', requested: false, usage, quota };
		}
		const ok = await storage.persist();
		return {
			status: ok ? 'persistent' : 'best-effort',
			requested: true,
			usage,
			quota
		};
	} catch {
		return { status: 'best-effort', requested: true, usage, quota };
	}
}

/** Read-only check without prompting. */
export async function getPersistenceStatus(): Promise<PersistenceStatus> {
	if (typeof navigator === 'undefined' || !navigator.storage?.persisted) {
		return 'unsupported';
	}
	try {
		return (await navigator.storage.persisted()) ? 'persistent' : 'best-effort';
	} catch {
		return 'best-effort';
	}
}
