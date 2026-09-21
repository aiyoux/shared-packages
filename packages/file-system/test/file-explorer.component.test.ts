/**
 * Component-level FileExplorer tests (jsdom).
 * Run: npm run test:component -w @shared-packages/file-system
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { packFiles } from '@shared-packages/compress';
import { sealVault } from '@shared-packages/crypto';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import FileExplorerToolbarExtraHarness from './FileExplorerToolbarExtraHarness.svelte';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';
import {
	createVfs,
	resetSharedVfsForTests,
	resetTransferRegistryForTests,
	type VfsService
} from '../src/index.ts';

describe('FileExplorer component', () => {
	let vfs: VfsService;

	beforeEach(async () => {
		resetSharedVfsForTests();
		resetTransferRegistryForTests();
		localStorage.removeItem('fe:previewDock');
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
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
		// Native DragEvent path — fireEvent.drop does not attach dataTransfer
		// reliably for Svelte 5 delegated handlers in jsdom, so `e.dataTransfer`
		// arrives null and the OS-drop guard silently declines. Same pattern as
		// file-explorer-dnd.component.test.ts.
		const dropEv = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(dropEv, 'dataTransfer', { value: dt });
		list.dispatchEvent(dropEv);
		await viWaitFor(async () => {
			const rows = await vfs.list({ parentId: null });
			return rows.some((n) => n.name === 'from-pc.txt');
		});
	});

	it('drops a desktop folder tree into nested VFS folders', async () => {
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await screen.findByTestId('fe-list');
		const list = screen.getByTestId('fe-list');
		const nested = new File(['inside'], 'notes.txt', { type: 'text/plain' });
		Object.defineProperty(nested, 'webkitRelativePath', { value: 'Trip/inner/notes.txt' });
		const dt = {
			types: ['Files'],
			files: {
				length: 1,
				0: nested,
				item: (i: number) => (i === 0 ? nested : null),
				[Symbol.iterator]: function* () {
					yield nested;
				}
			},
			dropEffect: 'none'
		};
		// Native DragEvent path — fireEvent.drop does not attach dataTransfer
		// reliably for Svelte 5 delegated handlers in jsdom, so `e.dataTransfer`
		// arrives null and the OS-drop guard silently declines. Same pattern as
		// file-explorer-dnd.component.test.ts.
		const dropEv = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(dropEv, 'dataTransfer', { value: dt });
		list.dispatchEvent(dropEv);
		await viWaitFor(async () => {
			const root = await vfs.list({ parentId: null });
			const trip = root.find((n) => n.name === 'Trip' && n.kind === 'folder');
			if (!trip) return false;
			const mid = await vfs.list({ parentId: trip.id });
			const inner = mid.find((n) => n.name === 'inner' && n.kind === 'folder');
			if (!inner) return false;
			const files = await vfs.list({ parentId: inner.id });
			return files.some((n) => n.name === 'notes.txt');
		});
		await viWaitFor(
			() =>
				Boolean(document.querySelector('[data-testid="fe-folder-row"][data-name="Trip"]'))
		);
	});

	it('uploads a picked folder through the folder-upload picker input', async () => {
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await screen.findByTestId('fe-list');
		expect(screen.getByTestId('fe-folder-upload').parentElement?.getAttribute('data-tooltip')).toBe(
			'Select folder'
		);
		const input = document.querySelector(
			'[data-testid="fe-folder-upload-input"]'
		) as HTMLInputElement | null;
		expect(input?.hasAttribute('webkitdirectory')).toBe(true);
		if (!input) return;
		const a = new File(['a-body'], 'a.txt', { type: 'text/plain' });
		Object.defineProperty(a, 'webkitRelativePath', { value: 'Picked/a.txt' });
		const b = new File(['b-body'], 'b.txt', { type: 'text/plain' });
		Object.defineProperty(b, 'webkitRelativePath', { value: 'Picked/inner/b.txt' });
		const files = [a, b];
		// Same FileList-literal pattern as the drop tests — jsdom inputs cannot
		// be assigned real FileLists.
		const fileList = {
			length: 2,
			0: a,
			1: b,
			item: (i: number) => files[i] ?? null,
			[Symbol.iterator]: function* () {
				yield* files;
			}
		};
		Object.defineProperty(input, 'files', { value: fileList, configurable: true });
		await fireEvent.change(input);
		// Same result as dragging the folder in: mkdir tree, nested write.
		await viWaitFor(async () => {
			const root = await vfs.list({ parentId: null });
			const picked = root.find((n) => n.name === 'Picked' && n.kind === 'folder');
			if (!picked) return false;
			const inner = await vfs.list({ parentId: picked.id });
			const dir = inner.find((n) => n.name === 'inner' && n.kind === 'folder');
			if (!dir) return false;
			const out = await vfs.list({ parentId: dir.id });
			return out.some((n) => n.name === 'b.txt');
		});
	});

	it('renders manage chrome with new folder and trash controls', async () => {
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		expect(await screen.findByTestId('file-explorer')).toBeTruthy();
		expect(screen.getByTestId('file-explorer').getAttribute('data-fe-mode')).toBe('manage');
		expect(screen.getByTestId('fe-new-folder')).toBeTruthy();
		expect(screen.getByTestId('fe-item-details')).toBeTruthy();
		expect(screen.getByTestId('fe-trash-view')).toBeTruthy();
		expect(screen.getByTestId('fe-breadcrumbs')).toBeTruthy();
		expect(screen.getByTestId('fe-header').querySelector('[data-testid="fe-breadcrumbs"]')).toBeTruthy();
		expect(screen.getByTestId('fe-system-paste')).toBeTruthy();
		expect((screen.getByTestId('fe-system-paste') as HTMLButtonElement).disabled).toBe(true);
		expect(document.querySelector('[data-testid="fe-new-menu"]')).toBeNull();
		expect(screen.getByTestId('fe-select-multi').parentElement?.getAttribute('data-tooltip')).toBe(
			'Select multiple items'
		);
		expect(screen.getByTestId('fe-item-details').parentElement?.getAttribute('data-tooltip')).toBe(
			'Select an item for details'
		);
		expect(screen.getByTestId('fe-new-folder').parentElement?.getAttribute('data-tooltip')).toBe(
			'New folder'
		);
		expect(screen.getByTestId('fe-upload').parentElement?.getAttribute('data-tooltip')).toBe(
			'Select file'
		);
		expect(screen.getByTestId('fe-trash-view').parentElement?.getAttribute('data-tooltip')).toBe(
			'Open trash'
		);
		expect(screen.getByTestId('fe-selection-actions')).toBeTruthy();
		expect((screen.getByTestId('fe-rename-btn') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId('fe-trash-selected') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId('fe-cut') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId('fe-copy') as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByTestId('fe-rename-btn').parentElement?.getAttribute('data-tooltip')).toBe(
			'Select one item to rename'
		);
		expect(screen.getByTestId('fe-trash-selected').parentElement?.getAttribute('data-tooltip')).toBe(
			'Select an item to delete'
		);
		expect(screen.getByTestId('fe-cut').parentElement?.getAttribute('data-tooltip')).toBe(
			'Select an item to cut'
		);
		expect(screen.getByTestId('fe-copy').parentElement?.getAttribute('data-tooltip')).toBe(
			'Select an item to copy'
		);
	});

	it('enables selection-action icons after a row is selected', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'Sketch',
			fileType: 'skch',
			body: { format: 'skch', schemaVersion: 1, name: 'Sketch', data: {} }
		});
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitForRows(1);
		expect((screen.getByTestId('fe-trash-selected') as HTMLButtonElement).disabled).toBe(true);
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		expect(row.classList.contains('selected')).toBe(true);
		expect((screen.getByTestId('fe-rename-btn') as HTMLButtonElement).disabled).toBe(false);
		expect((screen.getByTestId('fe-trash-selected') as HTMLButtonElement).disabled).toBe(false);
		expect((screen.getByTestId('fe-cut') as HTMLButtonElement).disabled).toBe(false);
		expect((screen.getByTestId('fe-copy') as HTMLButtonElement).disabled).toBe(false);
		expect(screen.getByTestId('fe-rename-btn').parentElement?.getAttribute('data-tooltip')).toBe(
			'Rename'
		);
		expect(screen.getByTestId('fe-trash-selected').parentElement?.getAttribute('data-tooltip')).toBe(
			'Delete'
		);
		expect(screen.getByTestId('fe-cut').parentElement?.getAttribute('data-tooltip')).toBe('Cut');
		expect(screen.getByTestId('fe-copy').parentElement?.getAttribute('data-tooltip')).toBe('Copy');
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
		expect(screen.queryByText('Click a row to select it')).toBeNull();
		expect(document.querySelector('[data-testid="fe-open-bar"]')).toBeNull();
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
		const previewZ = Number(getComputedStyle(preview).zIndex);
		const headerZ = Number(getComputedStyle(screen.getByTestId('fe-header')).zIndex);
		expect(previewZ).toBeGreaterThan(headerZ);
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

	it('details Quick edit is video-only and saves a sibling through the host callback', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'clip.webm',
			fileType: 'video',
			body: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/webm' }),
			contentType: 'video/webm'
		});
		await vfs.writeFile({
			parentId: null,
			name: 'note.txt',
			fileType: 'unknown',
			body: new Blob(['hello'], { type: 'text/plain' }),
			contentType: 'text/plain'
		});
		const hits: Array<{ name: string; saved?: string }> = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onQuickEditVideo: (entry, ctx) => {
					hits.push({ name: entry.name });
					void ctx
						.save(new File([new Uint8Array([9])], 'clip (trim).mp4', { type: 'video/mp4' }))
						.then((n) => {
							hits[hits.length - 1]!.saved = n.name;
						});
				}
			}
		});
		await viWaitForRows(2);

		const txt = document.querySelector(
			'[data-testid="fe-file-row"][data-name="note.txt"]'
		) as HTMLElement;
		await fireEvent.click(txt);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await screen.findByTestId('fe-file-preview');
		expect(screen.queryByTestId('fe-file-preview-quick-edit')).toBeNull();
		expect(screen.getByTestId('fe-file-preview-compress')).toBeTruthy();
		await fireEvent.click(screen.getByTestId('fe-file-preview-close'));

		const video = document.querySelector(
			'[data-testid="fe-file-row"][data-name="clip.webm"]'
		) as HTMLElement;
		await fireEvent.click(video);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const preview = await screen.findByTestId('fe-file-preview');
		const previewIds = [...preview.querySelectorAll('[data-testid]')].map((el) =>
			el.getAttribute('data-testid')
		);
		expect(previewIds.indexOf('fe-file-preview-quick-edit')).toBeGreaterThan(-1);
		expect(previewIds.indexOf('fe-file-preview-quick-edit')).toBeLessThan(
			previewIds.indexOf('fe-file-preview-compress')
		);
		await fireEvent.click(screen.getByTestId('fe-file-preview-quick-edit'));
		await viWaitFor(() => hits.length === 1 && hits[0]!.saved === 'clip (trim).mp4');
		expect(hits[0]!.name).toBe('clip.webm');
		const names = (await vfs.list({ parentId: null })).map((n) => n.name);
		expect(names).toContain('clip (trim).mp4');
	});

	it('details Quick edit is raster-only when the host passes onQuickEditImage', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'photo.png',
			fileType: 'image',
			body: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
			contentType: 'image/png'
		});
		await vfs.writeFile({
			parentId: null,
			name: 'anim.gif',
			fileType: 'image',
			body: new Blob([new Uint8Array([1])], { type: 'image/gif' }),
			contentType: 'image/gif'
		});
		const hits: Array<{ name: string; saved?: string }> = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onQuickEditImage: (entry, ctx) => {
					hits.push({ name: entry.name });
					void ctx
						.save(new File([new Uint8Array([9])], 'photo (edit).png', { type: 'image/png' }))
						.then((n) => {
							hits[hits.length - 1]!.saved = n.name;
						});
				}
			}
		});
		await viWaitForRows(2);

		const gif = document.querySelector(
			'[data-testid="fe-file-row"][data-name="anim.gif"]'
		) as HTMLElement;
		await fireEvent.click(gif);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await screen.findByTestId('fe-file-preview');
		expect(screen.queryByTestId('fe-file-preview-quick-edit')).toBeNull();
		expect(screen.getByTestId('fe-file-preview-compress')).toBeTruthy();
		await fireEvent.click(screen.getByTestId('fe-file-preview-close'));

		const png = document.querySelector(
			'[data-testid="fe-file-row"][data-name="photo.png"]'
		) as HTMLElement;
		await fireEvent.click(png);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const preview = await screen.findByTestId('fe-file-preview');
		const previewIds = [...preview.querySelectorAll('[data-testid]')].map((el) =>
			el.getAttribute('data-testid')
		);
		expect(previewIds.indexOf('fe-file-preview-quick-edit')).toBeGreaterThan(-1);
		expect(previewIds.indexOf('fe-file-preview-quick-edit')).toBeLessThan(
			previewIds.indexOf('fe-file-preview-compress')
		);
		await fireEvent.click(screen.getByTestId('fe-file-preview-quick-edit'));
		await viWaitFor(() => hits.length === 1 && hits[0]!.saved === 'photo (edit).png');
		expect(hits[0]!.name).toBe('photo.png');
		const names = (await vfs.list({ parentId: null })).map((n) => n.name);
		expect(names).toContain('photo (edit).png');
	});

	it('details Convert to SVG is offered for bitmaps, not text', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'photo.png',
			fileType: 'image',
			body: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
			contentType: 'image/png'
		});
		await vfs.writeFile({
			parentId: null,
			name: 'note.txt',
			fileType: 'unknown',
			body: new Blob(['hello'], { type: 'text/plain' }),
			contentType: 'text/plain'
		});
		const hits: string[] = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onQuickConvertSvg: (entry) => {
					hits.push(entry.name);
				}
			}
		});
		await viWaitForRows(2);

		const txt = document.querySelector(
			'[data-testid="fe-file-row"][data-name="note.txt"]'
		) as HTMLElement;
		await fireEvent.click(txt);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await screen.findByTestId('fe-file-preview');
		expect(screen.queryByTestId('fe-file-preview-convert-svg')).toBeNull();
		await fireEvent.click(screen.getByTestId('fe-file-preview-close'));

		const png = document.querySelector(
			'[data-testid="fe-file-row"][data-name="photo.png"]'
		) as HTMLElement;
		await fireEvent.click(png);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await screen.findByTestId('fe-file-preview');
		await fireEvent.click(screen.getByTestId('fe-file-preview-convert-svg'));
		expect(hits).toEqual(['photo.png']);
	});

	it('details Quick edit is hidden when the host does not pass a callback', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'clip.webm',
			fileType: 'video',
			body: new Blob([new Uint8Array([1])], { type: 'video/webm' }),
			contentType: 'video/webm'
		});
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitForRows(1);
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await screen.findByTestId('fe-file-preview');
		expect(screen.queryByTestId('fe-file-preview-quick-edit')).toBeNull();
		expect(screen.getByTestId('fe-file-preview-compress')).toBeTruthy();
	});

	it('details Compress and Encrypt open destination dialogs', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'note.txt',
			fileType: 'unknown',
			body: new Blob(['hello'], { type: 'text/plain' }),
			contentType: 'text/plain'
		});
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitForRows(1);
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await screen.findByTestId('fe-file-preview');
		await fireEvent.click(screen.getByTestId('fe-file-preview-compress'));
		const compressDlg = await screen.findByTestId('fe-archive-dialog');
		expect(compressDlg.getAttribute('data-kind')).toBe('compress');
		expect(screen.getByTestId('fe-archive-engine')).toBeTruthy();
		expect(screen.getByTestId('fe-archive-codec')).toBeTruthy();
		expect(screen.getByTestId('fe-archive-dest-same')).toBeTruthy();
		expect(screen.getByTestId('fe-archive-dest-memory')).toBeTruthy();
		await fireEvent.click(screen.getByTestId('fe-archive-cancel'));
		expect(screen.queryByTestId('fe-archive-dialog')).toBeNull();

		await fireEvent.click(screen.getByTestId('fe-file-preview-encrypt'));
		const encryptDlg = await screen.findByTestId('fe-archive-dialog');
		expect(encryptDlg.getAttribute('data-kind')).toBe('encrypt');
		expect(screen.getByTestId('fe-archive-password')).toBeTruthy();
		expect(screen.getByTestId('fe-archive-password-confirm')).toBeTruthy();
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

	it('empty trash keeps the popup open with progress and a header chip', async () => {
		await vfs.writeFile({ parentId: null, name: 'KeepMe.txt', body: 'keep' });
		const dir = await vfs.mkdir(null, 'repo');
		for (let i = 0; i < 6; i++) {
			await vfs.writeFile({ parentId: dir.id, name: `n${i}.txt`, body: `x${i}` });
		}
		await vfs.trash(dir.id);
		const driver = createLocalExplorerDriver(vfs);
		const realEmpty = driver.emptyTrash!.bind(driver);
		driver.emptyTrash = async (opts) => {
			opts?.onProgress?.({ done: 2, total: 10, name: 'repo' });
			await new Promise((r) => setTimeout(r, 80));
			opts?.onProgress?.({ done: 6, total: 10, name: 'n3.txt' });
			await new Promise((r) => setTimeout(r, 80));
			await realEmpty(opts);
		};
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await viWaitFor(
			() => !!document.querySelector('[data-testid="fe-list"] [data-testid="fe-file-row"][data-name="KeepMe.txt"]')
		);
		await fireEvent.click(screen.getByTestId('fe-trash-view'));
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-trash-popup"] [data-name="repo"]'));
		await fireEvent.click(screen.getByTestId('fe-empty-trash'));
		await fireEvent.click(await screen.findByTestId('fe-confirm-go'));
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-empty-trash-progress"]'));
		expect(screen.getByTestId('fe-empty-trash-progress').textContent).toMatch(/%/);
		expect(screen.getByTestId('fe-empty-trash-abort')).toBeTruthy();
		expect(screen.getByTestId('fe-op-progress-row').getAttribute('data-name')).toBe('Trash');
		expect(screen.getByTestId('fe-op-progress-row').getAttribute('title')).toMatch(/Emptying trash/i);
		expect(screen.getByTestId('fe-trash-popup')).toBeTruthy();
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-trash-empty"]'), 8000);
		const live = document.querySelectorAll('[data-testid="fe-list"] [data-testid="fe-file-row"]');
		expect([...live].some((r) => /KeepMe/.test(r.textContent || ''))).toBe(true);
	});

	it('empty trash cancel stops the job', async () => {
		const doomed = await vfs.writeFile({ parentId: null, name: 'Trashed.txt', body: 'gone' });
		await vfs.trash(doomed.id);
		const driver = createLocalExplorerDriver(vfs);
		driver.emptyTrash = async (opts) => {
			opts?.onProgress?.({ done: 1, total: 8, name: 'Trashed.txt' });
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(resolve, 30_000);
				opts?.signal?.addEventListener('abort', () => {
					clearTimeout(t);
					const e = new Error('Cancelled');
					e.name = 'AbortError';
					reject(e);
				});
			});
		};
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await fireEvent.click(screen.getByTestId('fe-trash-view'));
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-trash-popup"] [data-name="Trashed.txt"]'));
		await fireEvent.click(screen.getByTestId('fe-empty-trash'));
		await fireEvent.click(await screen.findByTestId('fe-confirm-go'));
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-empty-trash-abort"]'));
		await fireEvent.click(screen.getByTestId('fe-empty-trash-abort'));
		await viWaitFor(() => !document.querySelector('[data-testid="fe-empty-trash-progress"]'));
		expect(screen.getByTestId('fe-trash-popup').textContent).toMatch(/Trashed/);
	});

	it('double-click enters a folder', async () => {
		const folder = await vfs.mkdir(null, 'Docs');
		await vfs.writeFile({
			parentId: folder.id,
			name: 'inside.txt',
			fileType: 'unknown',
			body: new Blob(['hi'], { type: 'text/plain' }),
			contentType: 'text/plain'
		});
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-folder-row"]'));
		const folderRow = document.querySelector('[data-testid="fe-folder-row"]') as HTMLElement;
		await fireEvent.dblClick(folderRow);
		await viWaitForRows(1);
		const file = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		expect(file?.getAttribute('data-name')).toBe('inside.txt');
	});

	it('preview Open project calls detectProject then onOpenProject; folder double-click still enters', async () => {
		const proj = await vfs.mkdir(null, 'myproj');
		await vfs.mkdir(proj.id, '.git');
		await vfs.mkdir(null, 'plain');
		const opened: string[] = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onOpenProject: (entry: { name: string }) => {
					opened.push(entry.name);
				}
			}
		});
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-folder-row"]').length >= 2);

		const plain = document.querySelector('[data-testid="fe-folder-row"][data-name="plain"]') as HTMLElement;
		await fireEvent.click(plain);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const preview = await screen.findByTestId('fe-file-preview');
		await viWaitFor(() => preview.querySelector('[data-fe-is-project="false"]') != null);
		// Open project is offered on ANY folder (f9ddf6a): opening is how you
		// find out, and the git app toasts "Not a git project" if it isn't one.
		// Detection only drives Init, which is omitted here (no onInitProject).
		expect(preview.querySelector('[data-testid="fe-open-project"]')).not.toBeNull();
		expect(preview.querySelector('[data-testid="fe-init-project"]')).toBeNull();
		expect(opened).toEqual([]);

		await fireEvent.click(screen.getByTestId('fe-file-preview-close'));
		const projectRow = document.querySelector(
			'[data-testid="fe-folder-row"][data-name="myproj"]'
		) as HTMLElement;
		await fireEvent.click(projectRow);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await fireEvent.click(await screen.findByTestId('fe-open-project'));
		await viWaitFor(() => opened.length === 1);
		expect(opened).toEqual(['myproj']);

		await fireEvent.click(screen.getByTestId('fe-file-preview-close'));
		await fireEvent.dblClick(projectRow);
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-folder-row"][data-name=".git"]'));
		expect(opened).toEqual(['myproj']);
	});

	it('preview Init project on a non-git folder; git folder still offers Open project', async () => {
		const proj = await vfs.mkdir(null, 'myproj');
		await vfs.mkdir(proj.id, '.git');
		await vfs.mkdir(null, 'plain');
		const opened: string[] = [];
		const inited: string[] = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onOpenProject: (entry: { name: string }) => {
					opened.push(entry.name);
				},
				onInitProject: (entry: { name: string }) => {
					inited.push(entry.name);
				}
			}
		});
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-folder-row"]').length >= 2);

		const plain = document.querySelector('[data-testid="fe-folder-row"][data-name="plain"]') as HTMLElement;
		await fireEvent.click(plain);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const preview = await screen.findByTestId('fe-file-preview');
		await viWaitFor(() => preview.querySelector('[data-fe-is-project="false"]') != null);
		const initBtn = await screen.findByTestId('fe-init-project');
		expect(initBtn.textContent).toMatch(/Init project/);
		// Open is unconditional; only Init is gated on detection.
		expect(preview.querySelector('[data-testid="fe-open-project"]')).not.toBeNull();
		await fireEvent.click(initBtn);
		await viWaitFor(() => inited.length === 1);
		expect(inited).toEqual(['plain']);
		expect(opened).toEqual([]);

		await fireEvent.click(screen.getByTestId('fe-file-preview-close'));
		const projectRow = document.querySelector(
			'[data-testid="fe-folder-row"][data-name="myproj"]'
		) as HTMLElement;
		await fireEvent.click(projectRow);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const projPreview = await screen.findByTestId('fe-file-preview');
		await viWaitFor(() => projPreview.querySelector('[data-fe-is-project="true"]') != null);
		const openBtn = await screen.findByTestId('fe-open-project');
		expect(openBtn.textContent).toMatch(/Open project/);
		expect(projPreview.querySelector('[data-testid="fe-init-project"]')).toBeNull();
		await fireEvent.click(openBtn);
		await viWaitFor(() => opened.length === 1);
		expect(opened).toEqual(['myproj']);
		expect(inited).toEqual(['plain']);
	});

	it('double-click opens a file via onOpen', async () => {
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
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.dblClick(row);
		expect(opened).toHaveLength(1);
		expect(opened[0]).toMatch(/Sketch/);
	});

	it('Preview cycles below, beside, then off and shows the selected file', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'Sketch',
			fileType: 'skch',
			body: { format: 'skch', schemaVersion: 1, name: 'Sketch', data: {} }
		});
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitForRows(1);
		const root = screen.getByTestId('file-explorer');
		const toggle = screen.getByTestId('fe-preview-layout');
		expect(root.getAttribute('data-fe-preview-dock')).toBe('off');
		expect(screen.queryByTestId('fe-preview-dock')).toBeNull();

		await fireEvent.click(toggle);
		expect(root.getAttribute('data-fe-preview-dock')).toBe('bottom');
		const dock = await screen.findByTestId('fe-preview-dock');
		expect(dock.getAttribute('data-placement')).toBe('bottom');
		expect(dock.textContent).toMatch(/Select a file or folder/);

		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		await viWaitFor(() => /Sketch/.test(dock.textContent || ''));
		expect(screen.queryByTestId('fe-file-preview')).toBeNull();

		await fireEvent.click(toggle);
		expect(root.getAttribute('data-fe-preview-dock')).toBe('right');
		expect(screen.getByTestId('fe-preview-dock').getAttribute('data-placement')).toBe('right');

		await fireEvent.click(toggle);
		expect(root.getAttribute('data-fe-preview-dock')).toBe('off');
		expect(screen.queryByTestId('fe-preview-dock')).toBeNull();
	});

	it('shows Decompress and Open archive for a zip, and opens an inner filesystem popup', async () => {
		const packed = await packFiles(
			'fflate',
			[
				{ name: 'hello.txt', data: new TextEncoder().encode('hello') },
				{ name: 'nested/inner.txt', data: new TextEncoder().encode('inner') }
			],
			'zip'
		);
		const zip = packed[0]!;
		await vfs.writeFile({
			parentId: null,
			name: zip.name,
			body: zip.data,
			contentType: 'application/zip'
		});
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitForRows(1);
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await screen.findByTestId('fe-file-preview');
		expect(screen.getByTestId('fe-file-preview-decompress')).toBeTruthy();
		expect(screen.getByTestId('fe-file-preview-open-archive').textContent).toMatch(/Open archive/);
		expect(screen.getByTestId('fe-file-preview-open').textContent).toMatch(/Open archive/);
		expect((screen.getByTestId('fe-decompress-selected') as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.click(screen.getByTestId('fe-file-preview-decompress'));
		const dlg = await screen.findByTestId('fe-archive-dialog');
		expect(dlg.getAttribute('data-kind')).toBe('decompress');
		expect(screen.getByTestId('fe-archive-dest-popup')).toBeTruthy();
		await fireEvent.click(screen.getByTestId('fe-archive-cancel'));

		await fireEvent.click(screen.getByTestId('fe-file-preview-open-archive'));
		const inner = await screen.findByTestId('fe-inner-fs-dialog', undefined, { timeout: 8000 });
		expect(inner.textContent).toMatch(/archive\.zip|hello/);
		await viWaitFor(() => {
			const rows = inner.querySelectorAll('[data-testid="fe-file-row"], [data-testid="fe-folder-row"]');
			return rows.length >= 2;
		});
		expect(inner.querySelector('[data-name="hello.txt"]')).toBeTruthy();
		expect(inner.querySelector('[data-name="nested"]')).toBeTruthy();
	});

	it('shows Decrypt for a vault and packs multi-select as a ZIP inner filesystem', async () => {
		const sealed = await sealVault(
			'webcrypto',
			[{ path: 'secret.txt', data: new TextEncoder().encode('hidden') }],
			'pw',
			{ kind: 'single' }
		);
		await vfs.writeFile({
			parentId: null,
			name: sealed.name,
			body: sealed.data
		});
		await vfs.writeFile({
			parentId: null,
			name: 'a.txt',
			body: 'alpha'
		});
		await vfs.writeFile({
			parentId: null,
			name: 'b.txt',
			body: 'beta'
		});
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 3);

		const vaultRow = document.querySelector(`[data-testid="fe-file-row"][data-name="${sealed.name}"]`) as HTMLElement;
		await fireEvent.click(vaultRow);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await screen.findByTestId('fe-file-preview');
		expect(screen.getByTestId('fe-file-preview-decrypt')).toBeTruthy();
		expect(screen.getByTestId('fe-file-preview-open-archive').textContent).toMatch(/Open vault/);
		expect((screen.getByTestId('fe-decrypt-selected') as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.click(screen.getByTestId('fe-file-preview-decrypt'));
		const decryptDlg = await screen.findByTestId('fe-archive-dialog');
		expect(decryptDlg.getAttribute('data-kind')).toBe('decrypt');
		expect(screen.getByTestId('fe-archive-password')).toBeTruthy();
		expect(screen.queryByTestId('fe-archive-password-confirm')).toBeNull();
		expect(screen.getByTestId('fe-archive-dest-popup')).toBeTruthy();
		await fireEvent.click(screen.getByTestId('fe-archive-cancel'));
		await fireEvent.click(screen.getByTestId('fe-file-preview-close'));

		const aRow = document.querySelector('[data-testid="fe-file-row"][data-name="a.txt"]') as HTMLElement;
		const bRow = document.querySelector('[data-testid="fe-file-row"][data-name="b.txt"]') as HTMLElement;
		await fireEvent.click(aRow);
		await fireEvent.click(screen.getByTestId('fe-select-multi'));
		await fireEvent.click(bRow);
		await fireEvent.click(screen.getByTestId('fe-compress-selected'));
		const compressDlg = await screen.findByTestId('fe-archive-dialog');
		expect(compressDlg.getAttribute('data-kind')).toBe('compress');
		expect(compressDlg.textContent).toMatch(/2 items/);
		expect(compressDlg.textContent).toMatch(/ZIP inner filesystem/);
		expect((screen.getByTestId('fe-archive-codec') as HTMLSelectElement).disabled).toBe(true);
		expect((screen.getByTestId('fe-archive-codec') as HTMLSelectElement).value).toBe('zip');
	});

	it('rename editor fills the row, commits on check or click-outside, and cancels on x', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'RenameMe.txt',
			body: 'hi'
		});
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitForRows(1);
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		await fireEvent.click(screen.getByTestId('fe-rename-btn'));
		const input = await screen.findByTestId('fe-rename-input');
		expect(screen.getByTestId('fe-rename-ok')).toBeTruthy();
		expect(screen.getByTestId('fe-rename-cancel')).toBeTruthy();
		expect(input.parentElement?.classList.contains('fe-rename')).toBe(true);

		await fireEvent.input(input, { target: { value: 'ShouldNotStick.txt' } });
		await fireEvent.click(screen.getByTestId('fe-rename-cancel'));
		await viWaitFor(() => !document.querySelector('[data-testid="fe-rename-input"]'));
		expect(document.querySelector('[data-testid="fe-file-row"]')?.getAttribute('data-name')).toBe(
			'RenameMe.txt'
		);

		await fireEvent.click(row);
		await fireEvent.click(screen.getByTestId('fe-rename-btn'));
		const input2 = await screen.findByTestId('fe-rename-input');
		await fireEvent.input(input2, { target: { value: 'ClickedCheck.txt' } });
		await fireEvent.click(screen.getByTestId('fe-rename-ok'));
		await viWaitFor(() =>
			document.querySelector('[data-testid="fe-file-row"]')?.getAttribute('data-name') ===
			'ClickedCheck.txt'
		);

		await fireEvent.click(screen.getByTestId('fe-rename-btn'));
		const input3 = await screen.findByTestId('fe-rename-input');
		await fireEvent.input(input3, { target: { value: 'ClickedOut.txt' } });
		await fireEvent.pointerDown(screen.getByTestId('fe-list'));
		await viWaitFor(() =>
			document.querySelector('[data-testid="fe-file-row"]')?.getAttribute('data-name') ===
			'ClickedOut.txt'
		);
	});

	it('paints presence dots on the file row for fileId', async () => {
		const created = await vfs.writeFile({ parentId: null, name: 'Doc.kb', body: 'page' });
		const presenceByFileId = new Map([
			[created.id, [{ clientId: 'peer-1', color: 'var(--cat-rose)', name: 'Guest' }]]
		]);
		render(FileExplorer, {
			props: { mode: 'manage', vfs, variant: 'panel', presenceByFileId }
		});
		await viWaitForRows(1);
		const row = document.querySelector(
			`[data-testid="fe-file-row"][data-id="${created.id}"]`
		) as HTMLElement;
		expect(row).toBeTruthy();
		const dot = row.querySelector('[data-testid="fe-presence-dot"]') as HTMLElement;
		expect(dot).toBeTruthy();
		expect(dot.getAttribute('data-client-id')).toBe('peer-1');
		expect(dot.getAttribute('title')).toBe('Guest');
	});

	it('opens the file when a presence dot is clicked', async () => {
		const created = await vfs.writeFile({ parentId: null, name: 'Doc.kb', body: 'page' });
		const presenceByFileId = new Map([
			[created.id, [{ clientId: 'peer-1', color: 'var(--cat-rose)', name: 'Guest' }]]
		]);
		const opened: string[] = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				presenceByFileId,
				onOpen: (entry) => {
					opened.push(entry.id);
				}
			}
		});
		await viWaitForRows(1);
		await fireEvent.click(screen.getByTestId('fe-presence-dot'));
		expect(opened).toEqual([created.id]);
	});

	it('onContextChange picks up a rename so copy-across gets the new name', async () => {
		await vfs.writeFile({ parentId: null, name: 'Before.txt', body: 'hi' });
		const seen: string[] = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onContextChange: (ctx) => {
					const n = ctx.entries.find((e) => e.kind === 'file');
					if (n) seen.push(n.name);
				}
			}
		});
		await viWaitForRows(1);
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		await fireEvent.click(screen.getByTestId('fe-rename-btn'));
		const input = await screen.findByTestId('fe-rename-input');
		await fireEvent.input(input, { target: { value: 'After.txt' } });
		await fireEvent.click(screen.getByTestId('fe-rename-ok'));
		await viWaitFor(() => seen.includes('After.txt'));
		expect(seen[seen.length - 1]).toBe('After.txt');
	});

	it('turning Select multiple off deselects every selected row', async () => {
		await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'alpha' });
		await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'beta' });
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 2);
		const aRow = document.querySelector('[data-testid="fe-file-row"][data-name="a.txt"]') as HTMLElement;
		const bRow = document.querySelector('[data-testid="fe-file-row"][data-name="b.txt"]') as HTMLElement;
		await fireEvent.click(aRow);
		await fireEvent.click(screen.getByTestId('fe-select-multi'));
		expect(screen.getByTestId('fe-select-multi').getAttribute('aria-pressed')).toBe('true');
		await fireEvent.click(bRow);
		expect(aRow.classList.contains('selected')).toBe(true);
		expect(bRow.classList.contains('selected')).toBe(true);
		await fireEvent.click(screen.getByTestId('fe-select-multi'));
		expect(screen.getByTestId('fe-select-multi').getAttribute('aria-pressed')).toBe('false');
		expect(aRow.classList.contains('selected')).toBe(false);
		expect(bRow.classList.contains('selected')).toBe(false);
		expect(aRow.classList.contains('focused')).toBe(false);
		expect(bRow.classList.contains('focused')).toBe(false);
		expect((screen.getByTestId('fe-trash-selected') as HTMLButtonElement).disabled).toBe(true);
	});

	it('delete does not leave the next row looking selected', async () => {
		await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'alpha' });
		await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'beta' });
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 2);
		const aRow = document.querySelector('[data-testid="fe-file-row"][data-name="a.txt"]') as HTMLElement;
		await fireEvent.click(aRow);
		expect(aRow.classList.contains('selected')).toBe(true);
		await fireEvent.click(screen.getByTestId('fe-trash-selected'));
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length === 1);
		const bRow = document.querySelector('[data-testid="fe-file-row"][data-name="b.txt"]') as HTMLElement;
		expect(bRow).toBeTruthy();
		expect(bRow.classList.contains('selected')).toBe(false);
		expect(bRow.classList.contains('focused')).toBe(false);
		expect((screen.getByTestId('fe-trash-selected') as HTMLButtonElement).disabled).toBe(true);
	});

	it('details popup lists multi-selected items, combined size, and bulk ops', async () => {
		await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'alpha' });
		await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'beta' });
		await vfs.mkdir(null, 'Docs');
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 2);
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-folder-row"]'));
		const aRow = document.querySelector('[data-testid="fe-file-row"][data-name="a.txt"]') as HTMLElement;
		const bRow = document.querySelector('[data-testid="fe-file-row"][data-name="b.txt"]') as HTMLElement;
		const folder = document.querySelector('[data-testid="fe-folder-row"]') as HTMLElement;
		await fireEvent.click(aRow);
		await fireEvent.click(screen.getByTestId('fe-select-multi'));
		await fireEvent.click(bRow);
		await fireEvent.click(folder);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const preview = await screen.findByTestId('fe-file-preview');
		expect(preview.getAttribute('data-multi')).toBe('true');
		expect(screen.getByTestId('fe-file-preview-name').textContent).toMatch(/3 items selected/);
		expect(screen.getByTestId('fe-file-preview-count').textContent).toBe('3');
		const names = [...preview.querySelectorAll('[data-testid="fe-file-preview-item"]')].map((el) =>
			el.getAttribute('data-name')
		);
		expect(names.sort()).toEqual(['Docs', 'a.txt', 'b.txt']);
		expect(screen.getByTestId('fe-file-preview-size').textContent).toMatch(/\d+ B \+ 1 unknown/);
		expect(preview.querySelector('[data-testid="fe-file-preview-compress"]')).toBeTruthy();
		expect(preview.querySelector('[data-testid="fe-file-preview-encrypt"]')).toBeTruthy();
		expect(preview.querySelector('[data-testid="fe-row-copy"]')).toBeTruthy();
		expect(preview.querySelector('[data-testid="fe-cut"]')).toBeTruthy();
		expect(preview.querySelector('[data-testid="fe-row-trash"]')).toBeTruthy();
		expect(preview.querySelector('[data-testid="fe-rename-btn"]')).toBeNull();
		await fireEvent.click(screen.getByTestId('fe-file-preview-compress'));
		const compressDlg = await screen.findByTestId('fe-archive-dialog');
		expect(compressDlg.getAttribute('data-kind')).toBe('compress');
		expect(compressDlg.textContent).toMatch(/3 items/);
	});

	it('collapses toolbar actions into a more menu when the explorer is narrow', async () => {
		class NarrowResizeObserver {
			cb: ResizeObserverCallback;
			constructor(cb: ResizeObserverCallback) {
				this.cb = cb;
			}
			observe(target: Element) {
				this.cb(
					[
						{
							target,
							contentRect: {
								width: 360,
								height: 480,
								top: 0,
								left: 0,
								bottom: 480,
								right: 360,
								x: 0,
								y: 0,
								toJSON() {
									return {};
								}
							},
							borderBoxSize: [],
							contentBoxSize: [],
							devicePixelContentBoxSize: []
						} as ResizeObserverEntry
					],
					this as unknown as ResizeObserver
				);
			}
			unobserve() {}
			disconnect() {}
		}
		vi.stubGlobal('ResizeObserver', NarrowResizeObserver);
		try {
			render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
			expect(await screen.findByTestId('file-explorer')).toBeTruthy();
			expect(screen.getByTestId('file-explorer').getAttribute('data-fe-compact')).toBe('on');
			expect(screen.getByTestId('fe-toolbar-more')).toBeTruthy();
			expect(screen.getByTestId('fe-storage-persist')).toBeTruthy();
			expect(screen.queryByTestId('fe-upload')).toBeNull();
			expect(screen.queryByTestId('fe-selection-actions')).toBeNull();
			await fireEvent.click(screen.getByTestId('fe-toolbar-more'));
			const popup = await screen.findByTestId('fe-toolbar-more-popup');
			expect(popup.textContent).toMatch(/Upload file/);
			expect(popup.textContent).toMatch(/Download/);
			expect(popup.textContent).toMatch(/New folder/);
			expect(screen.getByTestId('fe-upload')).toBeTruthy();
			expect(screen.getByTestId('fe-download-selected')).toBeTruthy();
			expect(screen.getByTestId('fe-new-folder')).toBeTruthy();
			expect(screen.getByTestId('fe-rename-btn')).toBeTruthy();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('Copy across sits after Download and appears in the details popup', async () => {
		await vfs.writeFile({ parentId: null, name: 'note.txt', body: 'hello' });
		render(FileExplorerToolbarExtraHarness, { props: { vfs } });
		await viWaitForRows(1);
		const toolbar = screen.getByTestId('fe-toolbar');
		const toolbarIds = [...toolbar.querySelectorAll(':scope > .fe-toolbar-row:first-child [data-testid]')].map(
			(el) => el.getAttribute('data-testid')
		);
		expect(toolbarIds.indexOf('fe-copy-across-stub')).toBe(
			toolbarIds.indexOf('fe-download-selected') + 1
		);
		expect(screen.getByTestId('fe-selection-actions').querySelector('[data-testid="fe-copy-across-stub"]')).toBeNull();
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		await fireEvent.click(row);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const preview = await screen.findByTestId('fe-file-preview');
		expect(preview.querySelector('[data-testid="fe-file-preview-copy-across"]')).toBeTruthy();
		const previewIds = [...preview.querySelectorAll('[data-testid]')].map((el) =>
			el.getAttribute('data-testid')
		);
		expect(previewIds.indexOf('fe-file-preview-copy-across')).toBeGreaterThan(
			previewIds.indexOf('fe-file-preview-encrypt')
		);
	});

	it('shows Inside Project with map/storage/integrity, and Git enabled independently', async () => {
		const proj = await vfs.mkdir(null, 'studio');
		await vfs.writeFile({
			parentId: proj.id,
			name: '.project.json',
			body: JSON.stringify({ schemaVersion: 1, name: 'studio' }),
			contentType: 'application/json'
		});
		await vfs.mkdir(proj.id, '.git');
		const gitOnly = await vfs.mkdir(null, 'just-git');
		await vfs.mkdir(gitOnly.id, '.git');

		const maps: Array<string | null> = [];
		const gits: Array<string | null> = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onProjectMap: (id) => maps.push(id),
				onGitEnabled: (id) => gits.push(id)
			}
		});
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-folder-row"]').length >= 2);

		expect(document.querySelector('[data-testid="fe-inside-project-badge"]')).toBeNull();
		expect(document.querySelector('[data-testid="fe-git-enabled-badge"]')).toBeNull();

		const gitRow = document.querySelector(
			'[data-testid="fe-folder-row"][data-name="just-git"]'
		) as HTMLElement;
		await fireEvent.dblClick(gitRow);
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-git-enabled-badge"]'));
		expect(document.querySelector('[data-testid="fe-inside-project-badge"]')).toBeNull();
		await fireEvent.click(screen.getByTestId('fe-git-enabled-badge'));
		expect(gits).toEqual([gitOnly.id]);

		await fireEvent.click(screen.getByTestId('fe-crumb-root'));
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-folder-row"]').length >= 2);

		const projRow = document.querySelector(
			'[data-testid="fe-folder-row"][data-name="studio"]'
		) as HTMLElement;
		await fireEvent.dblClick(projRow);
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-inside-project-badge"]'));
		expect(screen.getByTestId('fe-git-enabled-badge')).toBeTruthy();
		expect(screen.getByTestId('fe-project-map')).toBeTruthy();
		expect(screen.getByTestId('fe-project-storage')).toBeTruthy();
		expect(screen.getByTestId('fe-project-integrity')).toBeTruthy();

		await fireEvent.click(screen.getByTestId('fe-project-map'));
		expect(maps).toEqual([proj.id]);

		await fireEvent.click(screen.getByTestId('fe-project-storage'));
		await screen.findByTestId('fe-project-storage-dialog');
		await fireEvent.click(screen.getByTestId('fe-project-storage-close'));

		await fireEvent.click(screen.getByTestId('fe-project-integrity'));
		const integrity = await screen.findByTestId('fe-storage-dialog');
		expect(integrity.getAttribute('aria-label')).toMatch(/Check project integrity|Project storage/);
	});

	it('marks git, project, and combined folders in the listing', async () => {
		const git = await vfs.mkdir(null, 'repo');
		await vfs.mkdir(git.id, '.git');
		const proj = await vfs.mkdir(null, 'studio');
		await vfs.writeFile({
			parentId: proj.id,
			name: '.project.json',
			body: JSON.stringify({ schemaVersion: 1, name: 'studio' }),
			contentType: 'application/json'
		});
		const both = await vfs.mkdir(null, 'full');
		await vfs.mkdir(both.id, '.git');
		await vfs.writeFile({
			parentId: both.id,
			name: '.project.json',
			body: JSON.stringify({ schemaVersion: 1, name: 'full' }),
			contentType: 'application/json'
		});
		await vfs.mkdir(null, 'plain');
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-folder-row"]').length >= 4);
		await viWaitFor(
			() =>
				document.querySelector('[data-testid="fe-folder-row"][data-name="repo"]')?.getAttribute(
					'data-fe-folder-mark'
				) === 'git'
		);
		expect(
			document.querySelector('[data-testid="fe-folder-row"][data-name="studio"]')?.getAttribute(
				'data-fe-folder-mark'
			)
		).toBe('project');
		expect(
			document.querySelector('[data-testid="fe-folder-row"][data-name="full"]')?.getAttribute(
				'data-fe-folder-mark'
			)
		).toBe('project-git');
		expect(
			document.querySelector('[data-testid="fe-folder-row"][data-name="plain"]')?.getAttribute(
				'data-fe-folder-mark'
			)
		).toBe('plain');
	});

	it('New menu sits left of Select multiple and offers New project', async () => {
		const parents: Array<string | null> = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onNewProject: (id) => parents.push(id)
			}
		});
		await screen.findByTestId('fe-list');
		const toolbar = screen.getByTestId('fe-toolbar');
		const toolbarIds = [
			...toolbar.querySelectorAll(':scope > .fe-toolbar-row:first-child [data-testid]')
		].map((el) => el.getAttribute('data-testid'));
		expect(toolbarIds.indexOf('fe-new-menu-btn')).toBe(toolbarIds.indexOf('fe-select-multi') - 1);
		expect(document.querySelector('[data-testid="fe-new-project"]')).toBeNull();

		await fireEvent.click(screen.getByTestId('fe-new-menu-btn'));
		await fireEvent.click(await screen.findByTestId('fe-new-project'));
		expect(parents).toEqual([null]);
	});

	it('New menu lists extra create actions and reports the open folder', async () => {
		const hits: Array<{ id: string; parent: string | null }> = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onNewProject: () => {},
				newMenuItems: [
					{ id: 'skch', label: 'New sketch', icon: 'pencil', testId: 'fe-new-skch' },
					{ id: 'anim', label: 'New animation', icon: 'film', testId: 'fe-new-anim' }
				],
				onNewMenuItem: (id, parent) => hits.push({ id, parent })
			}
		});
		await screen.findByTestId('fe-list');
		await fireEvent.click(screen.getByTestId('fe-new-menu-btn'));
		expect(await screen.findByTestId('fe-new-project')).toBeTruthy();
		await fireEvent.click(await screen.findByTestId('fe-new-skch'));
		expect(hits).toEqual([{ id: 'skch', parent: null }]);
	});

	it('hides the room chip when there is no onSwitchRoom', async () => {
		const proj = await vfs.mkdir(null, 'poster');
		await vfs.writeFile({
			parentId: proj.id,
			name: '.project.json',
			body: {
				schemaVersion: 1,
				name: 'poster',
				rooms: [{ id: 'r1', label: 'Poster' }],
				currentRoomId: 'r1'
			},
			contentType: 'application/json'
		});
		await vfs.mkdir(proj.id, '.git');
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-folder-row"]'));
		await fireEvent.dblClick(
			document.querySelector('[data-testid="fe-folder-row"][data-name="poster"]') as HTMLElement
		);
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-inside-project-badge"]'));
		expect(document.querySelector('[data-testid="fe-room-chip"]')).toBeNull();
	});

	it('shows the room chip with the current label and lists rooms', async () => {
		const proj = await vfs.mkdir(null, 'poster');
		await vfs.writeFile({
			parentId: proj.id,
			name: '.project.json',
			body: {
				schemaVersion: 1,
				name: 'poster',
				rooms: [
					{ id: 'r1', label: 'Poster' },
					{ id: 'r2', label: 'Side' }
				],
				currentRoomId: 'r1'
			},
			contentType: 'application/json'
		});
		await vfs.mkdir(proj.id, '.git');
		const switches: string[] = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onSwitchRoom: async ({ roomId }) => {
					switches.push(roomId);
					return 'ok';
				}
			}
		});
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-folder-row"]'));
		expect(document.querySelector('[data-testid="fe-room-chip"]')).toBeNull();

		await fireEvent.dblClick(
			document.querySelector('[data-testid="fe-folder-row"][data-name="poster"]') as HTMLElement
		);
		const chip = await screen.findByTestId('fe-room-chip');
		expect(chip.textContent).toMatch(/Poster/);
		await fireEvent.click(chip);
		const items = await screen.findAllByTestId('fe-room-item');
		expect(items.map((el) => el.getAttribute('data-room-id')).sort()).toEqual(['r1', 'r2']);
		expect(items.map((el) => el.textContent)).toEqual(
			expect.arrayContaining([expect.stringContaining('Poster'), expect.stringContaining('Side')])
		);
		const here = items.find((el) => el.getAttribute('data-room-id') === 'r1');
		await fireEvent.click(here!);
		expect(switches).toEqual(['r1']);
	});

	it('dirty stay does not switch; save and switch does', async () => {
		const proj = await vfs.mkdir(null, 'poster');
		await vfs.writeFile({
			parentId: proj.id,
			name: '.project.json',
			body: {
				schemaVersion: 1,
				name: 'poster',
				rooms: [
					{ id: 'r1', label: 'Poster' },
					{ id: 'r2', label: 'Side' }
				],
				currentRoomId: 'r1'
			},
			contentType: 'application/json'
		});
		await vfs.mkdir(proj.id, '.git');
		const switches: Array<{ roomId: string; save: boolean }> = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				onSwitchRoom: async ({ roomId, save }) => {
					switches.push({ roomId, save });
					return save ? 'ok' : 'dirty';
				}
			}
		});
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-folder-row"]'));
		await fireEvent.dblClick(
			document.querySelector('[data-testid="fe-folder-row"][data-name="poster"]') as HTMLElement
		);
		await screen.findByTestId('fe-room-chip');
		await fireEvent.click(screen.getByTestId('fe-room-chip'));
		const side = [...(await screen.findAllByTestId('fe-room-item'))].find((el) =>
			el.getAttribute('data-room-id') === 'r2'
		);
		expect(side).toBeTruthy();
		await fireEvent.click(side!);
		const dirty = await screen.findByTestId('fe-room-switch-dirty');
		expect(dirty.textContent).toMatch(/You have unsaved work in Poster/);
		expect(dirty.textContent).toMatch(/Save and switch/);
		expect(dirty.textContent).toMatch(/Stay/);
		await fireEvent.click(screen.getByTestId('fe-room-stay'));
		expect(document.querySelector('[data-testid="fe-room-switch-dirty"]')).toBeNull();
		expect(screen.getByTestId('fe-room-chip').textContent).toMatch(/Poster/);
		expect(switches).toEqual([{ roomId: 'r2', save: false }]);

		await fireEvent.click(screen.getByTestId('fe-room-chip'));
		const sideAgain = [...(await screen.findAllByTestId('fe-room-item'))].find((el) =>
			el.getAttribute('data-room-id') === 'r2'
		);
		await fireEvent.click(sideAgain!);
		await screen.findByTestId('fe-room-switch-dirty');
		await fireEvent.click(screen.getByTestId('fe-room-save-switch'));
		await viWaitFor(() => switches.some((s) => s.save));
		expect(switches).toEqual([
			{ roomId: 'r2', save: false },
			{ roomId: 'r2', save: false },
			{ roomId: 'r2', save: true }
		]);
		await viWaitFor(() => screen.getByTestId('fe-room-chip').textContent?.includes('Side') === true);
	});

	it('shows the people chip and sheet with revoke vs unlink copy', async () => {
		const proj = await vfs.mkdir(null, 'poster');
		await vfs.writeFile({
			parentId: proj.id,
			name: '.project.json',
			body: {
				schemaVersion: 1,
				name: 'poster',
				rooms: [{ id: 'r1', label: 'Poster' }],
				currentRoomId: 'r1'
			},
			contentType: 'application/json'
		});
		const unlinks: Array<{ pairingId: string; drain: string }> = [];
		const revokes: string[] = [];
		render(FileExplorer, {
			props: {
				mode: 'manage',
				vfs,
				variant: 'panel',
				people: [
					{
						pairingId: 'aa'.repeat(16),
						label: 'Alice',
						color: 'var(--cat-rose)',
						now: { kind: 'here' },
						sessionGrant: 'edit',
						canRevoke: true,
						linked: true
					},
					{
						pairingId: 'bb'.repeat(16),
						label: 'Bob',
						now: { kind: 'offline' },
						linked: true
					}
				],
				onInvitePeople: () => {},
				onRevokePerson: (id) => {
					revokes.push(id);
				},
				onUnlinkPerson: (id, drain) => {
					unlinks.push({ pairingId: id, drain });
				}
			}
		});
		await viWaitFor(() => !!document.querySelector('[data-testid="fe-folder-row"]'));
		await fireEvent.dblClick(
			document.querySelector('[data-testid="fe-folder-row"][data-name="poster"]') as HTMLElement
		);
		const chip = await screen.findByTestId('fe-people-chip');
		expect(chip.textContent).toMatch(/Alice/);
		expect(chip.textContent).toMatch(/\+1/);
		await fireEvent.click(chip);
		const sheet = await screen.findByTestId('fe-people-sheet');
		expect(sheet.textContent).toMatch(/In this room/);
		expect(sheet.textContent).toMatch(/offline/);
		expect(sheet.textContent).toMatch(/Linked/);
		expect(sheet.textContent).not.toMatch(/remote/i);
		expect(await screen.findByTestId('fe-people-invite')).toBeTruthy();

		await fireEvent.click(screen.getByTestId('fe-people-revoke'));
		const revoke = await screen.findByTestId('fe-people-revoke-dialog');
		const revokeCopy = (revoke.textContent ?? '').replace(/\s+/g, ' ');
		expect(revokeCopy).toMatch(
			/Alice can still send work later unless you unlink. This only affects the current session/
		);
		expect(revokeCopy).toMatch(/Revoke edit/);
		expect(revokeCopy).toMatch(/Unlink/);
		await fireEvent.click(screen.getByTestId('fe-people-revoke-confirm'));
		expect(revokes).toEqual(['aa'.repeat(16)]);

		if (!document.querySelector('[data-testid="fe-people-sheet"]')) {
			await fireEvent.click(screen.getByTestId('fe-people-chip'));
		}
		const unlinkBtns = await screen.findAllByTestId('fe-people-unlink');
		await fireEvent.click(unlinkBtns[0]!);
		const unlink = await screen.findByTestId('fe-people-unlink-dialog');
		const unlinkCopy = (unlink.textContent ?? '').replace(/\s+/g, ' ');
		expect(unlinkCopy).toMatch(/Unlink Alice\?/);
		expect(unlinkCopy).toMatch(/Stops future work from them. Work already in this project stays./);
		expect(unlinkCopy).toMatch(
			/Keeping their work first takes their last save — if they are still editing/
		);
		expect(unlinkCopy).not.toMatch(/revoke/i);
		// Alice is `here`, so keep-their-work is available. Bob (offline) is the
		// other row — that button is disabled separately.
		expect((screen.getByTestId('fe-people-unlink-sync') as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.click(screen.getByTestId('fe-people-unlink-without'));
		expect(unlinks).toEqual([{ pairingId: 'aa'.repeat(16), drain: 'without' }]);
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

/** Predicate may be async — two callers await the VFS inside it. */
async function viWaitFor(pred: () => boolean | Promise<boolean>, ms = 4000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (await pred()) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error('viWaitFor timeout');
}
