/**
 * DualPaneExplorer Open-project context (local pane).
 * Run: npm run test:component -w @shared-packages/file-system
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import DualPaneExplorer from '../src/ui/DualPaneExplorer.svelte';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';
import type { OpenProjectContext } from '../src/ui/explorerDriver.ts';
import { createVfs, resetSharedVfsForTests, type VfsService } from '../src/index.ts';
import { getMemoryVfs, resetMemoryVfsForTests } from '../src/memoryVfs.ts';
import { resetLayoutIdsForTests } from '@shared-packages/ui';
import { FE_EXPLORER_IDS_MIME } from '../src/ui/copyAcross.ts';

describe('DualPaneExplorer onOpenProject context', () => {
	let vfs: VfsService;

	beforeEach(async () => {
		resetSharedVfsForTests();
		resetMemoryVfsForTests();
		resetLayoutIdsForTests();
		localStorage.removeItem('fe:previewDock');
		vfs = createVfs({
			dbName: `dpe-open-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	/**
	 * Regression: DualPane wraps `onOpen` in `paneFileOpen`, which substitutes the
	 * pane's OpenProjectContext for FileExplorer's own `{ read }`. That is what
	 * lets the hub tell a monitor pane from a local one and raise the KB collab
	 * handoff. Reading `{ read }` here instead means the handoff silently stops
	 * firing, with nothing else to notice it.
	 */
	it('gives onOpen the pane context, not FileExplorer\'s { read }', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'Sketch',
			fileType: 'skch',
			body: { format: 'skch', schemaVersion: 1, name: 'Sketch', data: {} }
		});
		const opened: Array<{ name: string; ctx: unknown }> = [];
		render(DualPaneExplorer, {
			props: {
				localDriver: createLocalExplorerDriver(vfs),
				hideToggles: true,
				dualPaneKey: `dpe:dual:${Math.random()}`,
				onOpen: (entry, ctx) => {
					opened.push({ name: entry.name, ctx });
				}
			}
		});
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 1);

		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await fireEvent.click(await screen.findByTestId('fe-file-preview-open'));
		await viWaitFor(() => opened.length === 1);

		expect(opened[0]!.name).toBe('Sketch.skch');
		// The pane context, keyed on `kind` — not `{ read }`.
		expect(opened[0]!.ctx).toEqual({ kind: 'local' });
	});

	it('forwards OpenProjectContext.kind from the local pane', async () => {
		const proj = await vfs.mkdir(null, 'myproj');
		await vfs.mkdir(proj.id, '.git');
		const opened: Array<{ name: string; ctx: OpenProjectContext }> = [];
		render(DualPaneExplorer, {
			props: {
				localDriver: createLocalExplorerDriver(vfs),
				hideToggles: true,
				dualPaneKey: `dpe:dual:${Math.random()}`,
				onOpenProject: (entry, ctx) => {
					opened.push({ name: entry.name, ctx });
				}
			}
		});
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-folder-row"]').length >= 1);

		const projectRow = document.querySelector(
			'[data-testid="fe-folder-row"][data-name="myproj"]'
		) as HTMLElement;
		await fireEvent.click(projectRow);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await fireEvent.click(await screen.findByTestId('fe-open-project'));
		await viWaitFor(() => opened.length === 1);
		expect(opened).toEqual([{ name: 'myproj', ctx: { kind: 'local' } }]);
	});

	it('forwards InitProjectContext.kind from the local pane', async () => {
		await vfs.mkdir(null, 'plain');
		const inited: Array<{ name: string; ctx: OpenProjectContext }> = [];
		render(DualPaneExplorer, {
			props: {
				localDriver: createLocalExplorerDriver(vfs),
				hideToggles: true,
				dualPaneKey: `dpe:init:${Math.random()}`,
				onInitProject: (entry, ctx) => {
					inited.push({ name: entry.name, ctx });
				}
			}
		});
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-folder-row"]').length >= 1);

		const row = document.querySelector(
			'[data-testid="fe-folder-row"][data-name="plain"]'
		) as HTMLElement;
		await fireEvent.click(row);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await fireEvent.click(await screen.findByTestId('fe-init-project'));
		await viWaitFor(() => inited.length === 1);
		expect(inited).toEqual([{ name: 'plain', ctx: { kind: 'local' } }]);
	});

	it('Copy across sits after Download and appears in the details popup', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'across.txt',
			body: 'payload'
		});
		render(DualPaneExplorer, {
			props: {
				localDriver: createLocalExplorerDriver(vfs),
				hideToggles: false,
				dualPaneDefault: true,
				dualPaneKey: `dpe:dual:${Math.random()}`,
				settingsPortal: '#dpe-settings-missing'
			}
		});
		await viWaitFor(() => document.querySelectorAll('[data-pane="left"] [data-testid="fe-file-row"]').length >= 1);

		const left = document.querySelector('[data-pane="left"]') as HTMLElement;
		const toolbar = left.querySelector('[data-testid="fe-toolbar"]') as HTMLElement;
		const toolbarIds = [
			...toolbar.querySelectorAll(':scope > .fe-toolbar-row:first-child [data-testid]')
		].map((el) => el.getAttribute('data-testid'));
		expect(toolbarIds.indexOf('fe-copy-across-left')).toBe(
			toolbarIds.indexOf('fe-download-selected') + 1
		);
		expect(left.querySelector('[data-testid="fe-selection-actions"] [data-testid="fe-copy-across-left"]')).toBeNull();
		expect(left.querySelector('[data-testid="files-pane-chrome-left"] [data-testid="fe-copy-across-left"]')).toBeNull();

		const row = left.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		await fireEvent.click(left.querySelector('[data-testid="fe-item-details"]') as HTMLElement);
		const preview = await screen.findByTestId('fe-file-preview');
		expect(preview.querySelector('[data-testid="fe-file-preview-copy-across"]')).toBeTruthy();
	});

	it('Copy across sits after Download even when settings are not portaled', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'across.txt',
			body: 'payload'
		});
		render(DualPaneExplorer, {
			props: {
				localDriver: createLocalExplorerDriver(vfs),
				hideToggles: false,
				dualPaneDefault: true,
				dualPaneKey: `dpe:dual:${Math.random()}`
			}
		});
		await viWaitFor(() => document.querySelectorAll('[data-pane="left"] [data-testid="fe-file-row"]').length >= 1);

		const left = document.querySelector('[data-pane="left"]') as HTMLElement;
		const toolbarIds = [
			...left.querySelectorAll('[data-testid="fe-toolbar"] > .fe-toolbar-row:first-child [data-testid]')
		].map((el) => el.getAttribute('data-testid'));
		expect(toolbarIds.indexOf('fe-copy-across-left')).toBe(
			toolbarIds.indexOf('fe-download-selected') + 1
		);
		expect(left.querySelector('[data-testid="files-pane-chrome-left"]')).toBeNull();
	});

	it('windows overlay covers the file-manager header (connection / details / cut / copy)', async () => {
		render(DualPaneExplorer, {
			props: {
				localDriver: createLocalExplorerDriver(vfs),
				dualPaneKey: `dpe:windows-stack:${Math.random()}`
			}
		});
		await viWaitFor(() => document.querySelector('[data-testid="fe-header"]') != null);
		await fireEvent.click(screen.getByTestId('fe-windows-btn'));
		const overlay = await viWaitForEl('[data-testid="files-window-edit"]');
		const header = document.querySelector('[data-testid="fe-header"]') as HTMLElement;
		const body = overlay.parentElement?.querySelector('.aw-body') as HTMLElement | null;
		expect(header).toBeTruthy();
		expect(body).toBeTruthy();
		expect(getComputedStyle(body!).isolation).toBe('isolate');
		expect(Number(getComputedStyle(overlay).zIndex)).toBeGreaterThan(0);
		expect(header.contains(overlay)).toBe(false);
		expect(overlay.contains(header)).toBe(false);
	});
});

async function viWaitForEl(selector: string, ms = 4000): Promise<HTMLElement> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const el = document.querySelector(selector) as HTMLElement | null;
		if (el) return el;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`viWaitForEl timeout: ${selector}`);
}

function explorerDt(ids: string[]) {
	const data = new Map<string, string>();
	return {
		data,
		setData(type: string, val: string) {
			data.set(type, val);
		},
		getData(type: string) {
			return data.get(type) ?? '';
		},
		types: [FE_EXPLORER_IDS_MIME],
		effectAllowed: 'copyMove',
		dropEffect: 'copy'
	};
}

async function splitToThreePanes(): Promise<{ pane2: string; pane3: string }> {
	await viWaitFor(() => document.querySelectorAll('.files-pane[data-pane]').length >= 2);
	await fireEvent.click(screen.getByTestId('fe-windows-btn'));
	const splits = [...document.querySelectorAll('[data-testid="files-window-split-col"]')];
	expect(splits.length).toBeGreaterThanOrEqual(2);
	await fireEvent.click(splits[splits.length - 1]!);
	await viWaitFor(() => document.querySelectorAll('.files-pane[data-pane]').length >= 3);
	await fireEvent.click(screen.getByTestId('fe-windows-btn'));
	const ids = [...document.querySelectorAll('.files-pane[data-pane]')].map(
		(el) => el.getAttribute('data-pane')!
	);
	const unique = [...new Set(ids)];
	expect(unique.length).toBeGreaterThanOrEqual(3);
	const pane2 = unique.find((id) => id !== 'left')!;
	const pane3 = unique.find((id) => id !== 'left' && id !== pane2)!;
	return { pane2, pane3 };
}

async function switchPaneToMemory(paneId: string) {
	const root =
		(document.querySelector(`.files-pane[data-pane="${paneId}"]`) as HTMLElement | null) ??
		(document.querySelector(`[data-testid="conn-switcher-${paneId}"]`) as HTMLElement | null);
	if (!root) throw new Error(`pane ${paneId} not found`);
	const trigger = root.querySelector('[data-testid="conn-trigger"]') as HTMLElement;
	await fireEvent.click(trigger);
	const mem =
		(root.querySelector('[data-testid="conn-memory"]') as HTMLElement | null) ??
		(document.querySelector('[data-testid="conn-memory"]') as HTMLElement | null);
	if (!mem) throw new Error('conn-memory not found');
	await fireEvent.click(mem);
	await viWaitFor(() => {
		const label = root.querySelector('[data-testid="conn-trigger"]')?.textContent ?? '';
		return /memory/i.test(label);
	});
}

describe('DualPaneExplorer copy-across destinations', () => {
	let vfs: VfsService;

	beforeEach(async () => {
		resetSharedVfsForTests();
		resetMemoryVfsForTests();
		resetLayoutIdsForTests();
		localStorage.removeItem('fe:previewDock');
		vfs = createVfs({
			dbName: `dpe-copy-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	it('hides Target and outlines the dest window while dragging across', async () => {
		await vfs.writeFile({ parentId: null, name: 'drag-outline.txt', body: 'x' });
		render(DualPaneExplorer, {
			props: {
				localDriver: createLocalExplorerDriver(vfs),
				hideToggles: false,
				dualPaneDefault: true,
				dualPaneKey: `dpe:outline:${Math.random()}`
			}
		});
		await viWaitFor(
			() => document.querySelectorAll('[data-pane="left"] [data-testid="fe-file-row"]').length >= 1
		);
		await viWaitFor(() => document.querySelectorAll('.files-pane[data-pane]').length >= 2);
		expect(document.querySelector('[data-testid="files-window-target"]')).toBeTruthy();

		const src = document.querySelector(
			'[data-pane="left"] [data-testid="fe-file-row"]'
		) as HTMLElement;
		const dest = [...document.querySelectorAll('.files-pane[data-pane]')].find(
			(el) => el.getAttribute('data-pane') !== 'left'
		) as HTMLElement;
		const dt = explorerDt([src.getAttribute('data-fe-row-id')!]);
		const startEv = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(startEv, 'dataTransfer', { value: dt });
		src.dispatchEvent(startEv);
		await viWaitFor(() => document.querySelector('[data-testid="files-window-target"]') == null);

		const overEv = new MouseEvent('dragover', {
			bubbles: true,
			cancelable: true,
			clientX: 8,
			clientY: 8
		}) as DragEvent;
		Object.defineProperty(overEv, 'dataTransfer', { value: dt });
		dest.dispatchEvent(overEv);
		await viWaitFor(() => dest.classList.contains('drop-target'));
		const aw = dest.closest('.aw-leaf');
		expect(aw?.classList.contains('drop-target') || aw?.classList.contains('is-file-drop-target')).toBe(
			true
		);
	});

	it('two windows copy across immediately with no dest overlay', async () => {
		await vfs.writeFile({ parentId: null, name: 'solo.txt', body: 'x' });
		const key = `dpe:dual:${Math.random()}`;
		render(DualPaneExplorer, {
			props: {
				localDriver: createLocalExplorerDriver(vfs),
				hideToggles: false,
				dualPaneDefault: true,
				dualPaneKey: key
			}
		});
		await viWaitFor(
			() => document.querySelectorAll('[data-pane="left"] [data-testid="fe-file-row"]').length >= 1
		);
		const left = document.querySelector('[data-pane="left"]') as HTMLElement;
		await fireEvent.click(left.querySelector('[data-testid="fe-file-row"]') as HTMLElement);
		await fireEvent.click(left.querySelector('[data-testid="fe-copy-across-left"]') as HTMLElement);
		expect(document.querySelectorAll('[data-testid^="fe-copy-dest-overlay-"]').length).toBe(0);
	});

	it('three windows: Copy across overlays every pane except the source', async () => {
		await vfs.writeFile({ parentId: null, name: 'pick.txt', body: 'payload' });
		render(DualPaneExplorer, {
			props: {
				localDriver: createLocalExplorerDriver(vfs),
				hideToggles: false,
				dualPaneDefault: true,
				dualPaneKey: `dpe:triple:${Math.random()}`
			}
		});
		await viWaitFor(
			() => document.querySelectorAll('[data-pane="left"] [data-testid="fe-file-row"]').length >= 1
		);
		const { pane2, pane3 } = await splitToThreePanes();
		await switchPaneToMemory(pane3);

		expect(document.querySelectorAll('[data-testid^="fe-copy-dest-overlay-"]').length).toBe(0);
		const left = document.querySelector('[data-pane="left"]') as HTMLElement;
		await fireEvent.click(left.querySelector('[data-testid="fe-file-row"]') as HTMLElement);
		await fireEvent.click(left.querySelector('[data-testid="fe-copy-across-left"]') as HTMLElement);

		await viWaitFor(() => document.querySelector(`[data-testid="fe-copy-dest-overlay-${pane2}"]`) != null);
		expect(document.querySelector(`[data-testid="fe-copy-dest-overlay-${pane3}"]`)).toBeTruthy();
		expect(document.querySelector('[data-testid="fe-copy-dest-overlay-left"]')).toBeNull();

		await fireEvent.click(
			document.querySelector(`[data-testid="fe-copy-dest-overlay-${pane3}"]`) as HTMLElement
		);
		await viWaitFor(() => document.querySelectorAll('[data-testid^="fe-copy-dest-overlay-"]').length === 0);

		await viWaitFor(async () => (await getMemoryVfs().list()).length >= 1);
		const local = await vfs.list({ parentId: null });
		expect(local.filter((n) => n.kind === 'file').length).toBe(1);
	});

	it('drop copies into the pane under the pointer, not the first other window', async () => {
		const written = await vfs.writeFile({ parentId: null, name: 'drag-me.txt', body: 'payload' });
		render(DualPaneExplorer, {
			props: {
				localDriver: createLocalExplorerDriver(vfs),
				hideToggles: false,
				dualPaneDefault: true,
				dualPaneKey: `dpe:drop:${Math.random()}`
			}
		});
		await viWaitFor(
			() => document.querySelectorAll('[data-pane="left"] [data-testid="fe-file-row"]').length >= 1
		);
		const { pane2: _pane2, pane3 } = await splitToThreePanes();
		await switchPaneToMemory(pane3);

		const src = document.querySelector(
			'[data-pane="left"] [data-testid="fe-file-row"]'
		) as HTMLElement;
		const dest = document.querySelector(`.files-pane[data-pane="${pane3}"]`) as HTMLElement;
		const dt = explorerDt([written.id]);

		const startEv = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(startEv, 'dataTransfer', { value: dt });
		src.dispatchEvent(startEv);

		const dropEv = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(dropEv, 'dataTransfer', { value: dt });
		dest.dispatchEvent(dropEv);

		await viWaitFor(async () => (await getMemoryVfs().list()).length >= 1);
		const local = await vfs.list({ parentId: null });
		expect(local.filter((n) => n.kind === 'file').length).toBe(1);
	});
});

async function viWaitFor(pred: () => boolean | Promise<boolean>, ms = 4000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (await pred()) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error('viWaitFor timeout');
}
