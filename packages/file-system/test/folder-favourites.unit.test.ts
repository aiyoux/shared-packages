import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { persistKv } from '@shared-packages/ui/persistKv';
import {
	FOLDER_FAVOURITES_KEY, addFolderFavourite, removeFolderFavourite,
	readFolderFavourites, folderFavouriteId, resolveFavouriteFolder,
	subscribeFolderFavourites, type FolderFavourite
} from '../src/ui/folderFavourites.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

function favourite(kind: FolderFavourite['kind'], connectionId: string): FolderFavourite {
	return { id: folderFavouriteId(kind, connectionId, 'docs/'), kind, connectionId,
		folderId: 'docs/', name: 'Docs', path: '/Docs' };
}

describe('connection folder favourites', () => {
	beforeEach(async () => {
		await persistKv.ready();
		persistKv.remove(FOLDER_FAVOURITES_KEY);
	});

	it('keeps identical paths separate across profiles and kinds, and updates without duplicates', async () => {
		const first = favourite('b2', 'one');
		await addFolderFavourite(first);
		await addFolderFavourite(favourite('b2', 'two'));
		await addFolderFavourite(favourite('monitor', 'one'));
		await addFolderFavourite({ ...first, name: 'Renamed', path: '/Renamed' });
		assert.equal(readFolderFavourites().length, 3);
		assert.equal(readFolderFavourites()[0]!.id, first.id);
		assert.equal(readFolderFavourites().find((f) => f.id === first.id)?.name, 'Renamed');
		await removeFolderFavourite(first.id);
		assert.deepEqual(readFolderFavourites().map((f) => [f.kind, f.connectionId]), [['b2', 'two'], ['monitor', 'one']]);
	});

	it('notifies other explorer instances and retains records after flushing durable storage', async () => {
		const seen: FolderFavourite[][] = [];
		const stop = subscribeFolderFavourites((items) => seen.push(items));
		try {
			await addFolderFavourite(favourite('local', 'local'));
			await persistKv.flush();
			assert.equal(seen.at(-1)?.length, 1);
			assert.equal(readFolderFavourites()[0]?.connectionId, 'local');
			await removeFolderFavourite(readFolderFavourites()[0]!.id);
			assert.deepEqual(seen.at(-1), []);
		} finally { stop(); }
	});

	it('ignores malformed saved records and obsolete memory shortcuts', () => {
		persistKv.set(FOLDER_FAVOURITES_KEY, [null, {}, { ...favourite('local', 'local'), kind: 'memory' }, favourite('local', 'local')]);
		assert.deepEqual(readFolderFavourites(), [favourite('local', 'local')]);
	});

	it('rejects a deleted folder even when a remote driver synthesizes its path', async () => {
		const folder: ExplorerEntry = { id: 'docs/', parentId: null, name: 'Docs', kind: 'folder' };
		let exists = false;
		const driver = {
			ready: async () => {}, getPath: async () => [folder],
			list: async ({ parentId }: { parentId: string | null }) => ({ entries: parentId === null && exists ? [folder] : [], truncated: false })
		} as unknown as ExplorerDriver;
		await assert.rejects(resolveFavouriteFolder(driver, folder.id), /no longer exists/);
		exists = true;
		assert.deepEqual(await resolveFavouriteFolder(driver, folder.id), [folder]);
	});

	it('does not navigate when listing the target is forbidden', async () => {
		const folder: ExplorerEntry = { id: 'docs/', parentId: null, name: 'Docs', kind: 'folder' };
		const driver = {
			ready: async () => {}, getPath: async () => [folder],
			list: async ({ parentId }: { parentId: string | null }) => {
				if (parentId) throw new Error('Permission denied');
				return { entries: [folder], truncated: false };
			}
		} as unknown as ExplorerDriver;
		await assert.rejects(resolveFavouriteFolder(driver, folder.id), /Permission denied/);
	});
});
