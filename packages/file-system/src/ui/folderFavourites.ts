import { persistKv } from '@shared-packages/ui/persistKv';
import type { DiskDirHandle } from '../disk/handles.js';
import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

export const FOLDER_FAVOURITES_KEY = 'fe:folderFavourites:v1';

export type FolderFavourite = {
	id: string;
	kind: 'local' | 'b2' | 'monitor' | 'disk';
	connectionId: string;
	folderId: string;
	name: string;
	path: string;
	/** Native directory handles are structured-cloned into IndexedDB. */
	diskRoot?: DiskDirHandle;
};

export function folderFavouriteId(
	kind: FolderFavourite['kind'], connectionId: string, folderId: string
): string {
	return JSON.stringify([kind, connectionId, folderId]);
}

function decode(value: unknown): FolderFavourite[] {
	if (!Array.isArray(value)) return [];
	return value.filter((f): f is FolderFavourite => Boolean(
		f && typeof f === 'object' &&
		['local', 'b2', 'monitor', 'disk'].includes(f.kind) &&
		typeof f.connectionId === 'string' && typeof f.folderId === 'string' &&
		typeof f.name === 'string' && typeof f.path === 'string' &&
		f.id === folderFavouriteId(f.kind, f.connectionId, f.folderId) &&
		(f.kind !== 'disk' || f.diskRoot?.kind === 'directory')
	));
}

export function readFolderFavourites(): FolderFavourite[] {
	return decode(persistKv.get(FOLDER_FAVOURITES_KEY));
}

const listeners = new Set<(favourites: FolderFavourite[]) => void>();

function save(favourites: FolderFavourite[]) {
	persistKv.set(FOLDER_FAVOURITES_KEY, favourites);
	for (const listener of listeners) listener(favourites);
}

export async function addFolderFavourite(favourite: FolderFavourite): Promise<void> {
	await persistKv.ready();
	const current = readFolderFavourites();
	save(current.some((f) => f.id === favourite.id)
		? current.map((f) => f.id === favourite.id ? favourite : f)
		: [...current, favourite]);
}

export async function removeFolderFavourite(id: string): Promise<void> {
	await persistKv.ready();
	save(readFolderFavourites().filter((f) => f.id !== id));
}

/** Shared between explorer windows and instances, and kept current across tabs. */
export function subscribeFolderFavourites(listener: (favourites: FolderFavourite[]) => void): () => void {
	listeners.add(listener);
	listener(readFolderFavourites());
	void persistKv.ready().then(() => {
		if (listeners.has(listener)) listener(readFolderFavourites());
	});
	let channel: BroadcastChannel | undefined;
	if (typeof BroadcastChannel !== 'undefined') {
		try {
			channel = new BroadcastChannel('scratch-persist-kv');
			(channel as BroadcastChannel & { unref?: () => void }).unref?.();
			channel.onmessage = (event) => {
				if (event.data?.key === FOLDER_FAVOURITES_KEY) listener(decode(event.data.value));
			};
		} catch { /* The browser may restrict cross-tab messaging. */ }
	}
	return () => {
		listeners.delete(listener);
		channel?.close();
	};
}

/** Check both the target and its parent: some drivers synthesize breadcrumb paths. */
export async function resolveFavouriteFolder(driver: ExplorerDriver, folderId: string): Promise<ExplorerEntry[]> {
	await driver.ready();
	const path = await driver.getPath(folderId);
	const folder = path.at(-1);
	if (!folder || folder.id !== folderId || folder.kind !== 'folder') {
		throw new Error('That favourite folder no longer exists.');
	}
	// Remote path drivers may return a synthetic path for a deleted folder.
	const siblings = driver.listAll
		? { entries: await driver.listAll({ parentId: folder.parentId }), truncated: false }
		: await driver.list({ parentId: folder.parentId });
	if (!siblings.entries.some((entry) => entry.id === folderId && entry.kind === 'folder')) {
		throw new Error(siblings.truncated
			? 'Could not verify this favourite because its parent folder listing is incomplete.'
			: 'That favourite folder no longer exists or is unavailable.');
	}
	await driver.list({ parentId: folderId });
	return path;
}
