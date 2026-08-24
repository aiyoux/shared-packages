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
});

async function viWaitFor(pred: () => boolean, ms = 4000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error('viWaitFor timeout');
}
