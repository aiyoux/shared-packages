export const OPEN_PROJECT_KEY = 'scratch:open-project';
export const OPEN_PROJECT_TTL_MS = 60_000;
/** Last project Projects had open, so a reload reopens it instead of nothing. */
export const LAST_PROJECT_KEY = 'scratch:last-project';

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

function parsePayload(raw: string): OpenProjectPayload | null {
	try {
		const parsed = JSON.parse(raw) as OpenProjectPayload;
		if (parsed.backend !== 'local' && parsed.backend !== 'monitor') return null;
		if (typeof parsed.path !== 'string' || !parsed.path) return null;
		return parsed;
	} catch {
		return null;
	}
}

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
	const parsed = parsePayload(raw);
	if (!parsed) return null;
	const ts =
		typeof parsed.ts === 'number'
			? parsed.ts
			: typeof parsed.openedAt === 'number'
				? parsed.openedAt
				: now;
	if (now - ts > OPEN_PROJECT_TTL_MS) return null;
	return parsed;
}

function lastProjectStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
	return typeof localStorage === 'undefined' ? null : localStorage;
}

/** Remember the open project so reopening Projects restores it. No TTL. */
export function rememberProject(
	payload: OpenProjectPayload,
	storage = lastProjectStore()
): void {
	if (!storage) return;
	try {
		storage.setItem(LAST_PROJECT_KEY, JSON.stringify(payload));
	} catch {
		/* private mode / quota — remembering is best-effort */
	}
}

/** The remembered project, or null. Unlike the handoff this does not consume. */
export function recallProject(storage = lastProjectStore()): OpenProjectPayload | null {
	if (!storage) return null;
	let raw: string | null = null;
	try {
		raw = storage.getItem(LAST_PROJECT_KEY);
	} catch {
		return null;
	}
	if (!raw) return null;
	return parsePayload(raw);
}

export function forgetProject(storage = lastProjectStore()): void {
	if (!storage) return;
	try {
		storage.removeItem(LAST_PROJECT_KEY);
	} catch {
		/* ignore */
	}
}
