export const OPEN_PROJECT_KEY = 'scratch:open-project';
export const OPEN_PROJECT_TTL_MS = 60_000;

export type OpenProjectPayload = {
	backend: 'local' | 'monitor';
	/** Git path: VFS id for local, absolute host path for monitor. */
	path: string;
	/** Display name; prefer this over a raw VFS id in `path`. */
	label?: string;
	/** Explorer id for the tree, when distinct from `path`. */
	folderId?: string;
	profileId?: string;
	baseUrl?: string;
	/** Monitor profile root (driver clamp), when backend is monitor. */
	rootPath?: string;
	ts?: number;
	openedAt?: number;
};

/** Consume `scratch:open-project` once. Drops stale (>60s) or malformed payloads. */
export function consumeOpenProject(
	storage: Pick<Storage, 'getItem' | 'removeItem'> | null = typeof sessionStorage === 'undefined'
		? null
		: sessionStorage,
	now = Date.now()
): OpenProjectPayload | null {
	if (!storage) return null;
	const raw = storage.getItem(OPEN_PROJECT_KEY);
	if (!raw) return null;
	storage.removeItem(OPEN_PROJECT_KEY);
	try {
		const parsed = JSON.parse(raw) as OpenProjectPayload;
		if (parsed.backend !== 'local' && parsed.backend !== 'monitor') return null;
		if (typeof parsed.path !== 'string' || !parsed.path) return null;
		const ts =
			typeof parsed.ts === 'number'
				? parsed.ts
				: typeof parsed.openedAt === 'number'
					? parsed.openedAt
					: now;
		if (now - ts > OPEN_PROJECT_TTL_MS) return null;
		return parsed;
	} catch {
		return null;
	}
}
