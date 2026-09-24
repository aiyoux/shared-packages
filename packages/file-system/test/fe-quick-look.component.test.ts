/**
 * macOS-style Quick Look on Space in FileExplorer (jsdom).
 * Run: npm run test:component -w @shared-packages/file-system
 *
 * Tap Space pins the floating preview open (tap again to close); holding
 * Space peeks while held and closes on release. Entries without a preview
 * kind keep the legacy selection toggle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';
import {
	createVfs,
	resetSharedVfsForTests,
	resetTransferRegistryForTests,
	type VfsService
} from '../src/index.ts';

describe('FileExplorer Quick Look', () => {
	let vfs: VfsService;

	beforeEach(async () => {
		resetSharedVfsForTests();
		resetTransferRegistryForTests();
		vfs = createVfs({
			dbName: `fe-quicklook-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function mountWithFiles() {
		await vfs.writeFile({ parentId: null, name: 'notes.txt', body: 'hello preview' });
		await vfs.mkdir(null, 'Docs');
		const driver = createLocalExplorerDriver(vfs);
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('fe-list');
		const row = await waitFor(() => {
			const el = document.querySelector('[data-testid="fe-file-row"][data-name="notes.txt"]');
			expect(el).toBeTruthy();
			return el as HTMLElement;
		});
		await fireEvent.click(row);
		expect(row.getAttribute('aria-selected')).toBe('true');
		return row;
	}

	function popup() {
		return document.querySelector('.fe-float-card');
	}

	/** Space press with a controlled hold length (ms) between down and up. */
	async function pressSpace(target: HTMLElement, holdMs: number) {
		const now = vi.spyOn(Date, 'now');
		let t = 1_000_000;
		now.mockImplementation(() => t);
		await fireEvent.keyDown(target, { key: ' ' });
		t += holdMs;
		await fireEvent.keyUp(document.body, { key: ' ' });
		vi.restoreAllMocks();
	}

	it('tap pins the preview open; a second tap closes it', async () => {
		const row = await mountWithFiles();
		await pressSpace(row, 50);
		expect(popup()).toBeTruthy();
		await pressSpace(row, 50);
		expect(popup()).toBeNull();
	});

	it('holding space peeks while held and closes on release', async () => {
		const row = await mountWithFiles();
		const now = vi.spyOn(Date, 'now');
		let t = 2_000_000;
		now.mockImplementation(() => t);
		await fireEvent.keyDown(row, { key: ' ' });
		expect(popup()).toBeTruthy();
		t += 1000;
		await fireEvent.keyUp(document.body, { key: ' ' });
		vi.restoreAllMocks();
		expect(popup()).toBeNull();
	});

	it('ignores key repeats so a held tap stays pinned', async () => {
		const row = await mountWithFiles();
		const now = vi.spyOn(Date, 'now');
		let t = 3_000_000;
		now.mockImplementation(() => t);
		await fireEvent.keyDown(row, { key: ' ' });
		await fireEvent.keyDown(row, { key: ' ', repeat: true });
		t += 50;
		await fireEvent.keyUp(document.body, { key: ' ' });
		vi.restoreAllMocks();
		expect(popup()).toBeTruthy();
	});

	it('falls back to selection toggle for entries without a preview', async () => {
		await vfs.writeFile({ parentId: null, name: 'notes.txt', body: 'hello preview' });
		await vfs.mkdir(null, 'Docs');
		const driver = createLocalExplorerDriver(vfs);
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('fe-list');
		// Legacy Space semantics: toggle only when multi-select is on; a fresh
		// manage panel exclusive-selects instead. Turn the toggle on so the
		// fallback is observable as a deselect.
		await fireEvent.click(screen.getByTestId('fe-select-multi'));
		expect(screen.getByTestId('fe-select-multi').getAttribute('aria-pressed')).toBe('true');
		const folder = await waitFor(() => {
			const el = document.querySelector('[data-testid="fe-folder-row"][data-name="Docs"]');
			expect(el).toBeTruthy();
			return el as HTMLElement;
		});
		await fireEvent.click(folder);
		expect(folder.getAttribute('aria-selected')).toBe('true');
		await pressSpace(folder, 50);
		expect(popup()).toBeNull();
		expect(folder.getAttribute('aria-selected')).toBe('false');
	});
});
