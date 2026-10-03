import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/svelte';
import DualPaneExplorer from '../src/ui/DualPaneExplorer.svelte';
import ConnectionSwitcher from '../src/b2/ConnectionSwitcher.svelte';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';
import { createMemoryDiskRoot } from '../src/disk/memoryDisk.ts';
import { createVfs, resetSharedVfsForTests, type VfsService } from '../src/index.ts';
import { persistKv, resetLayoutIdsForTests } from '@shared-packages/ui';
import { FOLDER_FAVOURITES_KEY, readFolderFavourites, folderFavouriteId, type FolderFavourite } from '../src/ui/folderFavourites.ts';

describe('folder favourites UI', () => {
	let vfs: VfsService;
	beforeEach(async () => {
		await persistKv.ready();
		persistKv.remove(FOLDER_FAVOURITES_KEY);
		resetSharedVfsForTests();
		resetLayoutIdsForTests();
		vfs = createVfs({ dbName: `favourites-${Date.now()}-${Math.random()}`, memoryOpfs: true, requestPersist: false });
		await vfs.ready();
	});
	afterEach(() => vi.unstubAllGlobals());

	it('keeps computer-folder favourites attached when Svelte proxies the pane driver', async () => {
		const root = createMemoryDiskRoot('Work');
		const docs = await root.getDirectoryHandle('Docs', { create: true });
		await docs.getDirectoryHandle('Inside Docs', { create: true });
		vi.stubGlobal('showDirectoryPicker', async () => root);
		render(DualPaneExplorer, { localDriver: createLocalExplorerDriver(vfs), dualPaneKey: `fav-disk-${Math.random()}` });
		await fireEvent.click(await screen.findByTestId('conn-trigger'));
		await fireEvent.click(screen.getByTestId('conn-disk'));
		await fireEvent.dblClick(await screen.findByTestId('fe-folder-row'));
		await screen.findByTestId('fe-favourite-folder');
		await waitFor(() => expect(screen.getByTestId('fe-favourite-folder').hasAttribute('disabled')).toBe(false));
		await fireEvent.click(screen.getByTestId('fe-favourite-folder'));
		await waitFor(() => expect(readFolderFavourites()).toHaveLength(1));
		await fireEvent.click(screen.getByTestId('conn-trigger'));
		await fireEvent.click(screen.getByTestId('conn-local'));
		await waitFor(() => expect(screen.getByTestId('file-explorer').getAttribute('data-fe-backend')).toBe('local'));
		await fireEvent.click(screen.getByTestId('conn-trigger'));
		await fireEvent.click(screen.getByTestId('conn-favourite'));
		await waitFor(() => expect(screen.getByTestId('fe-folder-row').getAttribute('data-name')).toBe('Inside Docs'));
		expect(screen.getByTestId('fe-favourite-folder').getAttribute('aria-pressed')).toBe('true');
		await fireEvent.click(screen.getByTestId('conn-trigger'));
		expect(screen.getByTestId('conn-favourite').classList.contains('active')).toBe(true);
	});

	it('stars the current folder, shares the shortcut between panes, switches connection and navigates only the chosen pane', async () => {
		const folder = await vfs.mkdir(null, 'Projects');
		await vfs.mkdir(folder.id, 'Nested');
		render(DualPaneExplorer, { localDriver: createLocalExplorerDriver(vfs), dualPaneDefault: true, dualPaneKey: `fav-dual-${Math.random()}` });
		const left = within(await screen.findByTestId('files-pane-left'));
		await waitFor(() => expect(document.querySelectorAll('.files-pane')).toHaveLength(2));
		const right = within(document.querySelector('.files-pane:not([data-pane=left])') as HTMLElement);
		await fireEvent.dblClick(await left.findByTestId('fe-folder-row'));
		await left.findByTestId('fe-favourite-folder');
		await waitFor(() => expect(left.getByTestId('fe-favourite-folder').hasAttribute('disabled')).toBe(false));
		await fireEvent.click(left.getByTestId('fe-favourite-folder'));
		await waitFor(() => expect(readFolderFavourites()).toHaveLength(1));
		expect(left.getByTestId('fe-favourite-folder').getAttribute('aria-pressed')).toBe('true');
		await fireEvent.click(right.getByTestId('conn-trigger'));
		expect(right.getByTestId('conn-favourite').textContent).toContain('Projects');
		await fireEvent.click(right.getByTestId('conn-memory'));
		await waitFor(() => expect(right.getByTestId('file-explorer').getAttribute('data-fe-backend')).toBe('memory'));
		await fireEvent.click(right.getByTestId('conn-trigger'));
		await fireEvent.click(right.getByTestId('conn-favourite'));
		await waitFor(() => expect(right.getByTestId('fe-folder-row').getAttribute('data-name')).toBe('Nested'));
		expect(left.getByTestId('fe-folder-row').getAttribute('data-name')).toBe('Nested');
		await fireEvent.click(right.getByTestId('fe-favourite-folder'));
		await waitFor(() => expect(readFolderFavourites()).toHaveLength(0));
		expect(left.getByTestId('fe-favourite-folder').getAttribute('aria-pressed')).toBe('false');
	});

	it('favourites a folder from its context menu, survives remount, and keeps a missing shortcut available to remove', async () => {
		const folder = await vfs.mkdir(null, 'Docs');
		const props = { localDriver: createLocalExplorerDriver(vfs), dualPaneKey: `fav-single-${Math.random()}` };
		render(DualPaneExplorer, props);
		await screen.findByTestId('fe-folder-row');
		await waitFor(() => expect(screen.getByTestId('fe-list').getAttribute('aria-busy')).not.toBe('true'));
		await fireEvent.contextMenu(screen.getByTestId('fe-folder-row'), { clientX: 30, clientY: 40 });
		await fireEvent.click(await screen.findByTestId('fe-context-favourite-folder'));
		await waitFor(() => expect(readFolderFavourites()).toHaveLength(1));
		await persistKv.flush();
		cleanup();
		render(DualPaneExplorer, props);
		await fireEvent.click(await screen.findByTestId('conn-trigger'));
		expect(screen.getByTestId('conn-favourite').getAttribute('title')).toBe('/Docs');
		await vfs.trash(folder.id);
		await fireEvent.click(screen.getByTestId('conn-favourite'));
		await waitFor(() => expect(screen.getByTestId('files-pane-left').textContent).toContain('Could not open Docs'));
		expect(readFolderFavourites()).toHaveLength(1);
		await fireEvent.click(screen.getByTestId('conn-trigger'));
		await fireEvent.click(screen.getByTestId('conn-favourite-remove'));
		await waitFor(() => expect(readFolderFavourites()).toHaveLength(0));
	});

	it('groups favourites beneath their own B2 and Monitor profiles and supports keyboard selection', async () => {
		const favourite = (kind: 'b2' | 'monitor', connectionId: string, name: string): FolderFavourite => ({
			id: folderFavouriteId(kind, connectionId, 'docs/'), kind, connectionId, folderId: 'docs/', name, path: `/${name}`
		});
		const b2 = favourite('b2', 'one', 'B2 Docs');
		const monitor = favourite('monitor', 'two', 'Monitor Docs');
		const selected: FolderFavourite[] = [];
		render(ConnectionSwitcher, {
			profiles: [{ id: 'one', name: 'Backups' }], monitorProfiles: [{ id: 'two', name: 'Desktop' }],
			favourites: [monitor, b2], onSelectFavourite: (item) => selected.push(item)
		});
		await fireEvent.click(screen.getByTestId('conn-trigger'));
		const menu = screen.getByTestId('conn-menu');
		expect(menu.textContent!.indexOf('Backups')).toBeLessThan(menu.textContent!.indexOf('B2 Docs'));
		expect(menu.textContent!.indexOf('B2 Docs')).toBeLessThan(menu.textContent!.indexOf('Desktop'));
		expect(menu.textContent!.indexOf('Desktop')).toBeLessThan(menu.textContent!.indexOf('Monitor Docs'));
		await fireEvent.keyDown(menu, { key: 'End' });
		expect(document.activeElement?.getAttribute('data-testid')).toBe('conn-favourite-remove');
		await fireEvent.keyDown(menu, { key: 'ArrowUp' });
		expect(document.activeElement?.textContent).toContain('Monitor Docs');
		await fireEvent.click(document.activeElement!);
		expect(selected).toEqual([monitor]);
	});
});
