import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import ConnectionFilePicker from '../src/ui/ConnectionFilePicker.svelte';
import { getSharedVfs, resetSharedVfsForTests } from '../src/index.ts';
import { persistKv, resetLayoutIdsForTests } from '@shared-packages/ui';
import { FOLDER_FAVOURITES_KEY, folderFavouriteId, readFolderFavourites } from '../src/ui/folderFavourites.ts';
import type { ConnectionPick } from '../src/ui/connectionPickerTypes.ts';

describe('connection picker folder favourites', () => {
	const primedSharedVfs = async (): Promise<void> => {
		await persistKv.ready();
		persistKv.remove(FOLDER_FAVOURITES_KEY);
		resetSharedVfsForTests();
		resetLayoutIdsForTests();
		// The picker mints its browser-files driver from the shared vfs; prime
		// it here so the picker lists this test's isolated store.
		const sharedVfs = getSharedVfs({
			dbName: `picker-favourites-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await sharedVfs.ready();
		const projects = await sharedVfs.mkdir(null, 'Projects');
		await sharedVfs.mkdir(projects.id, 'Nested');
	};

	beforeEach(primedSharedVfs);
	afterEach(() => {
		vi.unstubAllGlobals();
		cleanup();
	});

	it('show favourited folders in the connection menu, star and star off, and jump', async () => {
		const picked: ConnectionPick[] = [];
		render(ConnectionFilePicker, {
			accept: ['text'],
			notice: '',
			onOpen: (pick) => {
				picked.push(pick);
			},
			onClose: () => {}
		});
		await waitFor(() => expect(screen.getByTestId('fe-list').getAttribute('aria-busy')).not.toBe('true'));
		await fireEvent.contextMenu(screen.getByTestId('fe-folder-row'), { clientX: 30, clientY: 40 });
		await fireEvent.click(await screen.findByTestId('fe-context-favourite-folder'));
		await waitFor(() => expect(readFolderFavourites()).toHaveLength(1));

		// The row lands in this picker's own connection menu.
		await fireEvent.click(await screen.findByTestId('conn-trigger'));
		const favouriteRow = screen.getByTestId('conn-favourite');
		expect(favouriteRow.textContent).toContain('Projects');

		// Jumping lands the explorer inside the favourited folder.
		await fireEvent.click(favouriteRow);
		await waitFor(() => expect(screen.getByTestId('fe-folder-row').getAttribute('data-name')).toBe('Nested'));
		await waitFor(() =>
			expect(screen.getByTestId('fe-favourite-folder').getAttribute('aria-pressed')).toBe('true')
		);

		// Jumping from another connection switches back to browser files first.
		await fireEvent.click(screen.getByTestId('conn-trigger'));
		await fireEvent.click(screen.getByTestId('conn-memory'));
		await waitFor(() => expect(screen.getByTestId('file-explorer').getAttribute('data-fe-backend')).toBe('memory'));
		await fireEvent.click(screen.getByTestId('conn-trigger'));
		await fireEvent.click(screen.getByTestId('conn-favourite'));
		await waitFor(() => expect(screen.getByTestId('fe-folder-row').getAttribute('data-name')).toBe('Nested'));

		// Stars toggle off too, from the current folder's row.
		await fireEvent.click(screen.getByTestId('fe-favourite-folder'));
		await waitFor(() => expect(readFolderFavourites()).toHaveLength(0));
		const stored = readFolderFavourites();
		expect(stored[0] === undefined || stored[0].id !== folderFavouriteId('local', 'local', 'Projects')).toBe(true);
	});
});