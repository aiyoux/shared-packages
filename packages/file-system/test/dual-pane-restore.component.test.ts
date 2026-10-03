import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { createLeaf, persistKv, splitLeaf } from '@shared-packages/ui';
import DualPaneExplorer from '../src/ui/DualPaneExplorer.svelte';
import { defaultFileWindows, saveFileWindows } from '../src/ui/fileWindows.js';
import type { ExplorerDriver } from '../src/ui/explorerDriver.js';

const remote = vi.hoisted(() => ({
	profilesReady: Promise.resolve(),
	b2Unreachable: false,
	monitor: { v: 1, id: 'saved-monitor', name: 'Saved monitor', baseUrl: 'http://localhost:8300', rootPath: '/work', createdAt: 1, updatedAt: 1 },
	b2: { rowId: 'saved-monitor.saved-b2', id: 'saved-b2', name: 'Saved B2', bucket: 'test', monitorProfileId: 'saved-monitor' },
	monitorDriver: null as unknown as ExplorerDriver,
	b2Driver: null as unknown as ExplorerDriver
}));
vi.mock('../src/monitor/credentials.js', async (importOriginal) => ({
	...await importOriginal<typeof import('../src/monitor/credentials.js')>(),
	listProfiles: vi.fn(async () => { await remote.profilesReady; return [remote.monitor]; }),
	getProfile: vi.fn(async () => remote.monitor)
}));
vi.mock('../src/b2/connections.js', async (importOriginal) => ({
	...await importOriginal<typeof import('../src/b2/connections.js')>(),
	listB2Connections: vi.fn(async () => {
		await remote.profilesReady;
		return remote.b2Unreachable
			? { rows: [], unreachable: [{ monitorProfileId: remote.monitor.id, monitorName: remote.monitor.name, message: 'Offline' }] }
			: { rows: [remote.b2], unreachable: [] };
	}),
	getB2Connection: vi.fn(async () => remote.b2)
}));
vi.mock('../src/monitor/monitorDriverCache.js', () => ({
	acquireMonitorDriver: vi.fn(async () => remote.monitorDriver), releaseMonitorDriver: vi.fn(), retainMonitorDriver: vi.fn()
}));
vi.mock('../src/b2/b2DriverCache.js', () => ({
	acquireB2Driver: vi.fn(async () => remote.b2Driver), releaseB2Driver: vi.fn(), retainB2Driver: vi.fn()
}));

function driver(id: string): ExplorerDriver {
	return {
		id, capabilities: {
			supportsTrash: false, supportsSoftDelete: false, supportsRename: false,
			supportsMove: false, supportsCopy: false, supportsMkdir: false,
			supportsUpload: false, supportsDownload: false, supportsSiblingOrder: false
		},
		ready: async () => {},
		delete: async () => {},
		list: async ({ parentId }) => ({
			entries: [{ id: `${id}-${parentId}-file`, parentId, kind: 'file', name: `${id}-${parentId ?? 'root'}.txt` }], truncated: false
		}),
		getPath: async (folderId) => [{ id: folderId, parentId: null, name: folderId, kind: 'folder' }]
	};
}

afterEach(() => { remote.profilesReady = Promise.resolve(); remote.b2Unreachable = false; vi.restoreAllMocks(); });

describe('File Manager refresh', () => {
	it('waits for persisted settings before mounting or saving a default layout', async () => {
		await persistKv.ready();
		let finishHydration!: () => void;
		const hydration = new Promise<void>((resolve) => { finishHydration = resolve; });
		vi.spyOn(persistKv, 'ready').mockReturnValue(hydration);
		const key = `file-refresh:hydrate:${Math.random()}`;
		const original = persistKv.getItem(key);
		const view = render(DualPaneExplorer, { props: { localDriver: driver('local'), dualPaneKey: key } });
		try {
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(view.container.querySelector('[data-testid="file-explorer"]')).toBeNull();
			expect(persistKv.getItem(key)).toBe(original);
			const windows = defaultFileWindows();
			windows.left.ctx.parentId = 'hydrated-folder';
			saveFileWindows(key, { root: createLeaf('left'), windows, focusedId: 'left', targetPaneId: 'left' });
			finishHydration();
			await waitFor(() => expect(view.container.textContent).toContain('local-hydrated-folder.txt'));
			expect(JSON.parse(persistKv.getItem(key)!).windows.left.parentId).toBe('hydrated-folder');
		} finally { finishHydration(); view.unmount(); }
	});

	it.each(['monitor', 'b2'] as const)('keeps the saved %s panes and folders while profiles load', async (kind) => {
		await persistKv.ready();
		let finishProfiles!: () => void;
		remote.profilesReady = new Promise<void>((resolve) => { finishProfiles = resolve; });
		remote.monitorDriver = driver('monitor');
		remote.b2Driver = driver('b2');
		const split = splitLeaf(createLeaf('left'), 'left', 'row')!;
		if (split.root.kind === 'split') split.root.ratio = 0.37;
		const secondId = split.newLeaf.id;
		const windows = defaultFileWindows();
		const activeId = kind === 'monitor' ? remote.monitor.id : remote.b2.rowId;
		for (const [id, folder] of [['left', 'first-folder'], [secondId, 'second-folder']]) {
			windows[id] = { ...windows.left, role: `${kind}:${activeId}`, activeKind: kind, activeId,
				ctx: { parentId: folder, backend: kind, entries: [], selectedIds: [] } };
		}
		const key = `file-refresh:${kind}:${Math.random()}`;
		saveFileWindows(key, { root: split.root, windows, focusedId: secondId, targetPaneId: secondId });
		const view = render(DualPaneExplorer, { props: { localDriver: driver('local'), dualPaneKey: key } });
		try {
			// The role catalogue is still loading: it must not erase saved connections.
			await new Promise((resolve) => setTimeout(resolve, 30));
			const duringLoad = JSON.parse(persistKv.getItem(key)!);
			expect(duringLoad.windows.left.activeKind).toBe(kind);
			expect(duringLoad.windows.left.parentId).toBe('first-folder');
			finishProfiles();
			await waitFor(() => {
				expect(view.container.querySelectorAll(`[data-fe-backend="${kind}"]`)).toHaveLength(2);
				expect(view.container.textContent).toContain(`${kind}-first-folder.txt`);
				expect(view.container.textContent).toContain(`${kind}-second-folder.txt`);
			});
			const restored = JSON.parse(persistKv.getItem(key)!);
			expect(restored.root).toEqual(split.root);
			expect(restored.windows.left.parentId).toBe('first-folder');
			expect(restored.windows[secondId].parentId).toBe('second-folder');
		} finally { finishProfiles(); view.unmount(); }
	});

	it('keeps an offline B2 connection and reopens its saved folder on retry', async () => {
		await persistKv.ready();
		remote.b2Unreachable = true;
		remote.b2Driver = driver('b2');
		const windows = defaultFileWindows();
		windows.left = { ...windows.left, role: `b2:${remote.b2.rowId}`, activeKind: 'b2', activeId: remote.b2.rowId,
			ctx: { parentId: 'saved-folder', backend: 'b2', entries: [], selectedIds: [] } };
		const key = `file-refresh:offline:${Math.random()}`;
		saveFileWindows(key, { root: createLeaf('left'), windows, focusedId: 'left', targetPaneId: 'left' });
		const view = render(DualPaneExplorer, { props: { localDriver: driver('local'), dualPaneKey: key } });
		try {
			await waitFor(() => expect(view.getByTestId('files-pane-retry-left')).toBeTruthy());
			const saved = JSON.parse(persistKv.getItem(key)!);
			expect(saved.windows.left.activeKind).toBe('b2');
			expect(saved.windows.left.activeId).toBe(remote.b2.rowId);
			expect(saved.windows.left.parentId).toBe('saved-folder');
			expect(view.container.querySelector('[data-fe-backend="local"]')).toBeNull();
			remote.b2Unreachable = false;
			await fireEvent.click(view.getByTestId('files-pane-retry-left'));
			await waitFor(() => expect(view.container.textContent).toContain('b2-saved-folder.txt'));
			expect(JSON.parse(persistKv.getItem(key)!).windows.left.parentId).toBe('saved-folder');
		} finally { view.unmount(); }
	});
});
