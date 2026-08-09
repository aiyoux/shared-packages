/**
 * Component-level FileExplorer tests (jsdom).
 * Run: npm run test:component -w @shared-packages/file-system
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import { createVfs, resetSharedVfsForTests, type VfsService } from '../src/index.ts';

describe('FileExplorer component', () => {
	let vfs: VfsService;

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({
			dbName: `fe-comp-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	it('renders manage chrome with new folder and trash controls', async () => {
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		expect(await screen.findByTestId('file-explorer')).toBeTruthy();
		expect(screen.getByTestId('file-explorer').getAttribute('data-fe-mode')).toBe('manage');
		expect(screen.getByTestId('fe-new-folder')).toBeTruthy();
		expect(screen.getByTestId('fe-trash-view')).toBeTruthy();
		expect(screen.getByTestId('fe-breadcrumbs')).toBeTruthy();
	});

	it('shows storage persistence chip for local VFS and can hide it', async () => {
		const { unmount } = render(FileExplorer, {
			props: { mode: 'manage', vfs, variant: 'panel' }
		});
		const chip = await screen.findByTestId('fe-storage-persist');
		expect(chip).toBeTruthy();
		// jsdom: navigator.storage.persist is typically unsupported → not "loading" forever
		await viWaitFor(() => {
			const st = chip.getAttribute('data-status');
			return st === 'unsupported' || st === 'best-effort' || st === 'persistent';
		});
		unmount();

		render(FileExplorer, {
			props: { mode: 'manage', vfs, variant: 'panel', showPersistence: false }
		});
		await screen.findByTestId('file-explorer');
		expect(document.querySelector('[data-testid="fe-storage-persist"]')).toBeNull();
	});

	it('lists seeded files and greys out incompatible types under accept', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'Sketch',
			fileType: 'skch',
			body: { format: 'skch', schemaVersion: 1, name: 'Sketch', data: {} }
		});
		await vfs.writeFile({
			parentId: null,
			name: 'Voice',
			fileType: 'vrec',
			body: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
			contentType: 'audio/webm'
		});

		render(FileExplorer, {
			props: { mode: 'open', accept: ['skch'] as const, vfs, variant: 'panel' }
		});

		await viWaitForRows(2);
		const rows = document.querySelectorAll('[data-testid="fe-file-row"]');
		expect(rows.length).toBeGreaterThanOrEqual(2);
		const incompatible = Array.from(rows).find((r) => r.classList.contains('incompatible'));
		expect(incompatible).toBeTruthy();
		expect(incompatible?.getAttribute('data-file-type')).toBe('vrec');
	});

	it('creates a folder via New folder form', async () => {
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await screen.findByTestId('file-explorer');
		await fireEvent.click(screen.getByTestId('fe-new-folder'));
		const input = await screen.findByTestId('fe-new-folder-input');
		await fireEvent.input(input, { target: { value: 'Comp Folder' } });
		await fireEvent.click(screen.getByTestId('fe-new-folder-confirm'));
		await viWaitFor(() => {
			const el = document.querySelector('[data-testid="fe-folder-row"]');
			return !!el && /Comp Folder/.test(el.textContent || '');
		});
		const listed = await vfs.list({ parentId: null });
		expect(listed.some((n) => n.kind === 'folder' && n.name === 'Comp Folder')).toBe(true);
	});
});

async function viWaitForRows(min: number, ms = 4000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (document.querySelectorAll('[data-testid="fe-file-row"]').length >= min) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error(`expected >= ${min} file rows`);
}

async function viWaitFor(pred: () => boolean, ms = 4000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error('viWaitFor timeout');
}
