import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { persistKv, resetLayoutIdsForTests } from '@shared-packages/ui';
import DualPaneExplorer from '../src/ui/DualPaneExplorer.svelte';
import { createVfs, type VfsService } from '../src/index.ts';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';
import type { ExplorerDriver } from '../src/ui/explorerDriver.ts';
import {
	FOLDER_FAVOURITES_KEY, addFolderFavourite, folderFavouriteId, readFolderFavourites
} from '../src/ui/folderFavourites.ts';

const remote = vi.hoisted(() => ({
	drivers: new Map<string, ExplorerDriver>(),
	monitor: { v: 1 as const, id: 'monitor-saved', name: 'Desktop', baseUrl: 'http://localhost:8300', rootPath: '/code', createdAt: 1, updatedAt: 1 },
	b2: { rowId: 'b2-saved', name: 'Backups', bucket: 'photos', monitorName: 'Desktop' },
	connect: vi.fn()
}));

vi.mock('../src/monitor/index.js', async (importOriginal) => ({
	...await importOriginal<typeof import('../src/monitor/index.js')>(),
	listProfiles: async () => [remote.monitor],
	getProfile: async (id: string) => id === remote.monitor.id ? remote.monitor : undefined,
	acquireMonitorDriver: async (profile: { id: string }) => { remote.connect(profile.id); return remote.drivers.get(profile.id)!; },
	releaseMonitorDriver: () => {}
}));
vi.mock('../src/b2/index.js', async (importOriginal) => ({
	...await importOriginal<typeof import('../src/b2/index.js')>(),
	listB2Connections: async () => ({ rows: [remote.b2], unreachable: [] }),
	getB2Connection: async (id: string) => id === remote.b2.rowId ? remote.b2 : undefined,
	acquireB2Driver: async (row: { rowId: string }) => { remote.connect(row.rowId); return remote.drivers.get(row.rowId)!; },
	releaseB2Driver: () => {}, setActiveB2RowId: () => {}
}));

describe('remote favourite navigation', () => {
	let vfs: VfsService;
	beforeEach(async () => {
		await persistKv.ready();
		persistKv.remove(FOLDER_FAVOURITES_KEY);
		resetLayoutIdsForTests();
		remote.drivers.clear(); remote.connect.mockClear();
		vfs = createVfs({ dbName: `remote-fav-${Math.random()}`, memoryOpfs: true, requestPersist: false });
		await vfs.ready();
	});

	for (const kind of ['monitor', 'b2'] as const) {
		it(`connects ${kind} before opening its favourite, and can retry after a folder becomes available`, async () => {
			const folder = await vfs.mkdir(null, 'Remote folder');
			await vfs.mkdir(folder.id, 'Remote child');
			const profileId = kind === 'monitor' ? remote.monitor.id : remote.b2.rowId;
			const local = createLocalExplorerDriver(vfs);
			let available = false;
			const driver: ExplorerDriver = {
				...local, id: kind, connectionId: profileId,
				list: async (options) => {
					if (options.parentId === folder.id && !available) throw new Error('Permission denied');
					return local.list(options);
				}
			};
			remote.drivers.set(profileId, driver);
			await addFolderFavourite({
				id: folderFavouriteId(kind, profileId, folder.id), kind, connectionId: profileId,
				folderId: folder.id, name: folder.name, path: '/Remote folder'
			});
			render(DualPaneExplorer, { localDriver: local, dualPaneKey: `remote-fav-pane-${Math.random()}` });
			await screen.findByTestId(kind === 'monitor' ? 'conn-monitor-profile' : 'conn-b2-profile');
			await fireEvent.click(screen.getByTestId('conn-trigger'));
			await fireEvent.click(await screen.findByTestId('conn-favourite'));
			await waitFor(() => expect(screen.getByTestId('files-pane-left').textContent).toContain('Permission denied'));
			expect(remote.connect).toHaveBeenCalledWith(profileId);
			expect(readFolderFavourites()).toHaveLength(1);
			available = true;
			await waitFor(() => expect(screen.getByTestId('conn-trigger').hasAttribute('disabled')).toBe(false));
			await fireEvent.click(screen.getByTestId('conn-trigger'));
			await fireEvent.click(screen.getByTestId('conn-favourite'));
			await waitFor(() => expect(screen.getByTestId('fe-folder-row').getAttribute('data-name')).toBe('Remote child'));
			expect(screen.getByTestId('file-explorer').getAttribute('data-fe-backend')).toBe(kind);
			expect(remote.connect).toHaveBeenCalledTimes(1);
		});
	}
});
