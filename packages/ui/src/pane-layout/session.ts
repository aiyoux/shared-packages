import { clampRatio } from './tree.js';
import type { LayoutLeaf, LayoutNode, LayoutSplit } from './types.js';

/** Query key written onto the workspace URL so a refresh can find the snapshot. */
export const PANE_SESSION_QUERY = 's';

export const PANE_SESSION_VERSION = 1 as const;

export const PANE_SESSION_STORAGE_PREFIX = 'sp:pane-session:';

export type PaneSessionSnapshot<TView = unknown> = {
	version: typeof PANE_SESSION_VERSION;
	id: string;
	root: LayoutNode;
	focusedId: string | null;
	views: Record<string, TView>;
	updatedAt: number;
};

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type PaneSessionStore<TView = unknown> = {
	load(id: string): PaneSessionSnapshot<TView> | null;
	save(snapshot: PaneSessionSnapshot<TView>): void;
	remove(id: string): void;
};

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, URL-safe id. 12 chars is enough to isolate tabs without cluttering the address bar. */
export function createSessionId(): string {
	const bytes = new Uint8Array(12);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	let out = '';
	for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
	return out;
}

export function readSessionId(search: string | URLSearchParams): string | null {
	const params =
		typeof search === 'string'
			? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
			: search;
	const raw = params.get(PANE_SESSION_QUERY)?.trim() ?? '';
	return raw.length > 0 ? raw : null;
}

/**
 * Return `path?query#hash` with the session id set. Accepts a path (`/tools`),
 * a path+search, or an absolute URL — the result is always path+search+hash so
 * callers can feed it to `history.replaceState` / SvelteKit `replaceState`.
 */
export function applySessionId(url: string | URL, id: string): string {
	const raw = typeof url === 'string' ? url : url.pathname + url.search + url.hash;
	const hashAt = raw.indexOf('#');
	const withoutHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
	const hash = hashAt === -1 ? '' : raw.slice(hashAt);
	const queryAt = withoutHash.indexOf('?');
	const path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
	const search = queryAt === -1 ? '' : withoutHash.slice(queryAt + 1);
	const params = new URLSearchParams(search);
	params.set(PANE_SESSION_QUERY, id);
	const qs = params.toString();
	return qs ? `${path}?${qs}${hash}` : `${path}${hash}`;
}

export function isWorkspacePath(pathname: string): boolean {
	return pathname === '/tools' || pathname === '/tools/';
}

export function parseLayoutNode(raw: unknown): LayoutNode | null {
	if (!raw || typeof raw !== 'object') return null;
	const node = raw as Record<string, unknown>;
	if (node.kind === 'leaf') {
		if (typeof node.id !== 'string' || !node.id) return null;
		const leaf: LayoutLeaf = { kind: 'leaf', id: node.id };
		return leaf;
	}
	if (node.kind === 'split') {
		if (typeof node.id !== 'string' || !node.id) return null;
		if (node.direction !== 'row' && node.direction !== 'col') return null;
		const first = parseLayoutNode(node.first);
		const second = parseLayoutNode(node.second);
		if (!first || !second) return null;
		const split: LayoutSplit = {
			kind: 'split',
			id: node.id,
			direction: node.direction,
			ratio: clampRatio(typeof node.ratio === 'number' ? node.ratio : Number(node.ratio)),
			first,
			second
		};
		return split;
	}
	return null;
}

export function parsePaneSessionSnapshot<TView>(
	raw: unknown,
	parseView?: (value: unknown) => TView | null
): PaneSessionSnapshot<TView> | null {
	if (!raw || typeof raw !== 'object') return null;
	const snap = raw as Record<string, unknown>;
	if (snap.version !== PANE_SESSION_VERSION) return null;
	if (typeof snap.id !== 'string' || !snap.id) return null;
	const root = parseLayoutNode(snap.root);
	if (!root) return null;
	if (snap.focusedId !== null && typeof snap.focusedId !== 'string') return null;
	if (!snap.views || typeof snap.views !== 'object' || Array.isArray(snap.views)) return null;

	const views: Record<string, TView> = {};
	for (const [leafId, value] of Object.entries(snap.views as Record<string, unknown>)) {
		if (!leafId) continue;
		if (parseView) {
			const view = parseView(value);
			if (view != null) views[leafId] = view;
		} else {
			views[leafId] = value as TView;
		}
	}

	const updatedAt = typeof snap.updatedAt === 'number' && Number.isFinite(snap.updatedAt) ? snap.updatedAt : 0;
	return {
		version: PANE_SESSION_VERSION,
		id: snap.id,
		root,
		focusedId: snap.focusedId,
		views,
		updatedAt
	};
}

function defaultStorages(): StorageLike[] {
	const out: StorageLike[] = [];
	for (const key of ['sessionStorage', 'localStorage'] as const) {
		try {
			const storage = (globalThis as unknown as Record<string, StorageLike | undefined>)[key];
			if (storage && typeof storage.getItem === 'function') out.push(storage);
		} catch {
			/* private mode / blocked storage */
		}
	}
	return out;
}

export function createPaneSessionStore<TView = unknown>(opts?: {
	storages?: StorageLike[];
	prefix?: string;
	parseView?: (value: unknown) => TView | null;
}): PaneSessionStore<TView> {
	const prefix = opts?.prefix ?? PANE_SESSION_STORAGE_PREFIX;
	const parseView = opts?.parseView;

	const storages = (): StorageLike[] => opts?.storages ?? defaultStorages();

	function keyFor(id: string): string {
		return `${prefix}${id}`;
	}

	return {
		load(id: string) {
			if (!id) return null;
			const key = keyFor(id);
			for (const storage of storages()) {
				let raw: string | null = null;
				try {
					raw = storage.getItem(key);
				} catch {
					continue;
				}
				if (!raw) continue;
				try {
					const parsed = parsePaneSessionSnapshot<TView>(JSON.parse(raw), parseView);
					if (parsed && parsed.id === id) return parsed;
				} catch {
					/* corrupt slot — try the next storage */
				}
			}
			return null;
		},
		save(snapshot) {
			if (!snapshot?.id) return;
			const payload = JSON.stringify({
				version: PANE_SESSION_VERSION,
				id: snapshot.id,
				root: snapshot.root,
				focusedId: snapshot.focusedId,
				views: snapshot.views,
				updatedAt: snapshot.updatedAt
			});
			const key = keyFor(snapshot.id);
			for (const storage of storages()) {
				try {
					storage.setItem(key, payload);
				} catch {
					/* quota / private mode */
				}
			}
		},
		remove(id: string) {
			if (!id) return;
			const key = keyFor(id);
			for (const storage of storages()) {
				try {
					storage.removeItem(key);
				} catch {
					/* ignore */
				}
			}
		}
	};
}
