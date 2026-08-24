/**
 * Component-level FileExplorer tests (jsdom).
 * Run: npm run test:component -w @shared-packages/file-system
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { packFiles } from '@shared-packages/compress';
import { sealVault } from '@shared-packages/crypto';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import { createVfs, resetSharedVfsForTests, type VfsService } from '../src/index.ts';

describe('FileExplorer component', () => {
	let vfs: VfsService;

	beforeEach(async () => {
		resetSharedVfsForTests();
		localStorage.removeItem('fe:previewDock');
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
		await fireEvent.drop(list, { dataTransfer: dt });
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

	it('renders manage chrome with new folder and trash controls', async () => {
		render(FileExplorer, { props: { mode: 'manage', vfs, variant: 'panel' } });
		expect(await screen.findByTestId('file-explorer')).toBeTruthy();
		expect(screen.getByTestId('file-explorer').getAttribute('data-fe-mode')).toBe('manage');
		expect(screen.getByTestId('fe-new-folder')).toBeTruthy();
		expect(screen.getByTestId('fe-item-details')).toBeTruthy();
		expect(screen.getByTestId('fe-trash-view')).toBeTruthy();
		expect(screen.getByTestId('fe-breadcrumbs')).toBeTruthy();
		expect(screen.getByTestId('fe-system-paste')).toBeTruthy();
		expect((screen.getByTestId('fe-system-paste') as HTMLButtonElement).disabled).toBe(true);
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

	it('details Compress and Encrypt open destination dialogs', async () => {
		await vfs.writeFile({
			parentId: null,
			name: 'note.txt',
			fileType: 'txt',
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

	it('double-click enters a folder', async () => {
		const folder = await vfs.mkdir(null, 'Docs');
		await vfs.writeFile({
			parentId: folder.id,
			name: 'inside.txt',
			fileType: 'txt',
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
		const btn = await screen.findByTestId('fe-open-project');
		expect(btn.textContent).toMatch(/Open project/);
		await fireEvent.click(btn);
		expect(await screen.findByTestId('fe-error')).toBeTruthy();
		expect(screen.getByTestId('fe-error').textContent).toMatch(/Not a git project/);
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
		const inner = await screen.findByTestId('fe-inner-fs-dialog', { timeout: 8000 });
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
