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

describe('DualPaneExplorer onOpenProject context', () => {
	let vfs: VfsService;

	beforeEach(async () => {
		resetSharedVfsForTests();
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
});

async function viWaitFor(pred: () => boolean, ms = 4000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error('viWaitFor timeout');
}
