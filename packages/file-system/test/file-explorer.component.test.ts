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

	it('drops an OS file into the open folder via writeFile', async () => {
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await screen.findByTestId('fe-list');
		const list = screen.getByTestId('fe-list');
		const file = new File(['hello-os'], 'from-pc.txt', { type: 'text/plain' });
		const dt = {
			types: ['Files'],
			files: {
				length: 1,
				0: file,
				item: (i: number) => (i === 0 ? file : null),
				[Symbol.iterator]: function* () {
					yield file;
				}
			},
			dropEffect: 'none'
		};
		await fireEvent.drop(list, { dataTransfer: dt });
		await viWaitFor(async () => {
			const rows = await vfs.list({ parentId: null });
			return rows.some((n) => n.name === 'from-pc.txt');
		});
	});

	it('renders manage chrome with new folder and trash controls', async () => {
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		expect(await screen.findByTestId('file-explorer')).toBeTruthy();
		expect(screen.getByTestId('file-explorer').getAttribute('data-fe-mode')).toBe('manage');
		expect(screen.getByTestId('fe-new-folder')).toBeTruthy();
		expect(screen.getByTestId('fe-upload')).toBeTruthy();
		expect(screen.getByTestId('fe-item-details')).toBeTruthy();
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

	it('pointerup selects the row; Details opens the item popup', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'Sketch',
			fileType: 'skch',
			body: { format: 'skch', schemaVersion: 1, name: 'Sketch', data: {} }
		});
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitForRows(1);
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		const nameEl = row.querySelector('.fe-name') as HTMLElement;
		await fireEvent.pointerDown(nameEl, { button: 0, clientX: 10, clientY: 10 });
		await fireEvent.pointerUp(nameEl, { button: 0, clientX: 11, clientY: 10 });
		expect(row.classList.contains('selected')).toBe(true);
		expect(screen.queryByTestId('fe-file-preview')).toBeNull();
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const preview = await screen.findByTestId('fe-file-preview');
		expect(preview).toBeTruthy();
		expect(screen.getByTestId('fe-file-preview-name').textContent).toMatch(/Sketch/);
		expect(preview.querySelector('[data-testid="fe-rename-btn"]')).toBeTruthy();
		expect(preview.querySelector('[data-testid="fe-row-copy"]')).toBeTruthy();
		expect(preview.querySelector('[data-testid="fe-row-trash"]')).toBeTruthy();
		expect(screen.queryByTestId('fe-open-selected')).toBeNull();
		expect(document.querySelector('[data-testid="fe-file-row"] [data-testid="fe-rename-btn"]')).toBeNull();
	});

	it('file preview Open calls onOpen with a sketcher label', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'Sketch',
			fileType: 'skch',
			body: { format: 'skch', schemaVersion: 1, name: 'Sketch', data: {} }
		});
		const opened: string[] = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onOpen: (entry: { name: string }) => {
					opened.push(entry.name);
				}
			}
		});
		await viWaitForRows(1);
		expect(screen.queryByTestId('fe-open-selected')).toBeNull();
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		expect(opened).toEqual([]);
		expect(row.classList.contains('selected')).toBe(true);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const openBtn = await screen.findByTestId('fe-file-preview-open');
		expect(openBtn.textContent).toMatch(/sketcher/i);
		await fireEvent.click(openBtn);
		expect(opened).toEqual(['Sketch.skch']);
	});

	it('single-click on a folder selects it; Details opens the popup; Open enters it', async () => {
		await vfs.mkdir(null, 'Docs');
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-folder-row"]'));
		const row = document.querySelector('[data-testid="fe-folder-row"]') as HTMLElement;
		await fireEvent.click(row);
		expect(row.classList.contains('selected')).toBe(true);
		expect(screen.queryByTestId('fe-file-preview')).toBeNull();
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const preview = await screen.findByTestId('fe-file-preview');
		const openBtn = screen.getByTestId('fe-file-preview-open');
		expect(openBtn.textContent).toMatch(/^Open$/);
		expect(preview.querySelector('[data-testid="fe-rename-btn"]')).toBeTruthy();
		expect(preview.querySelector('[data-testid="fe-row-trash"]')).toBeTruthy();
		await fireEvent.click(openBtn);
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-empty"]'));
		expect(document.querySelector('[data-testid="fe-folder-row"]')).toBeNull();
	});

	it('Select multi restores click-to-toggle; toolbar Open calls onOpen', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'Sketch',
			fileType: 'skch',
			body: { format: 'skch', schemaVersion: 1, name: 'Sketch', data: {} }
		});
		const opened: string[] = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onOpen: (entry: { name: string }) => {
					opened.push(entry.name);
				}
			}
		});
		await viWaitForRows(1);
		await fireEvent.click(screen.getByTestId('fe-select-multi'));
		expect(screen.getByTestId('fe-select-multi').getAttribute('aria-pressed')).toBe('true');
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		expect(row.classList.contains('selected')).toBe(true);
		expect(screen.queryByTestId('fe-file-preview')).toBeNull();
		const openBtn = await screen.findByTestId('fe-open-selected');
		await fireEvent.click(openBtn);
		expect(opened).toEqual(['Sketch.skch']);
	});

	it('preview Send this file calls onSendFile', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'note.txt',
			fileType: 'unknown',
			body: 'hi'
		});
		const sent: string[] = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onSendFile: (entry: { name: string }) => {
					sent.push(entry.name);
				}
			}
		});
		await viWaitForRows(1);
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row.querySelector('.fe-name')!);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await fireEvent.click(await screen.findByTestId('fe-file-preview-send'));
		expect(sent).toEqual(['note.txt']);
	});

	it('second explorer lists a file written through the shared VFS', async () => {
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await screen.findAllByTestId('file-explorer');
		await vfs.writeFile({
			parentId: null,
			name: 'live-peer.txt',
			fileType: 'unknown',
			body: 'x'
		});
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 2);
		const rows = [...document.querySelectorAll('[data-testid="fe-file-row"]')];
		expect(rows.filter((r) => /live-peer/.test(r.textContent || '')).length).toBeGreaterThanOrEqual(2);
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

	it('opens trash as a popup listing without replacing the live folder', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'KeepMe',
			fileType: 'unknown',
			body: 'keep'
		});
		const doomed = await vfs.writeFile({
			parentId: null,
			name: 'Trashed',
			fileType: 'unknown',
			body: 'gone'
		});
		await vfs.trash(doomed.id);

		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitForRows(1);
		expect(screen.queryByTestId('fe-trash-popup')).toBeNull();
		const live = document.querySelectorAll('[data-testid="fe-list"] [data-testid="fe-file-row"]');
		expect([...live].some((r) => /KeepMe/.test(r.textContent || ''))).toBe(true);
		expect([...live].some((r) => /Trashed/.test(r.textContent || ''))).toBe(false);

		await fireEvent.click(screen.getByTestId('fe-trash-view'));
		await viWaitFor(() => {
			const popup = document.querySelector('[data-testid="fe-trash-popup"]');
			return !!popup && /Trashed/.test(popup.textContent || '');
		});
		expect(screen.getByTestId('fe-restore')).toBeTruthy();
		expect(screen.getByTestId('fe-permanent-delete')).toBeTruthy();
		const stillLive = document.querySelectorAll('[data-testid="fe-list"] [data-testid="fe-file-row"]');
		expect([...stillLive].some((r) => /KeepMe/.test(r.textContent || ''))).toBe(true);
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
