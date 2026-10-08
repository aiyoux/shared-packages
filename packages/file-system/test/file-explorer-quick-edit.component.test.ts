import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { persistKv } from '@shared-packages/ui';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import { installLockPolyfill } from './live-locks-harness.ts';

installLockPolyfill();
import type { ExplorerDriver, ExplorerEntry, QuickEditFileContext } from '../src/ui/explorerDriver.ts';

const media = [
	['photo.png', 'image', 'image/png'], ['clip.webm', 'video', 'video/webm'], ['song.wav', 'audio', 'audio/wav']
] as const;
const connections = [
	['local', 'writeFile'], ['memory', 'writeFile'], ['disk', 'writeFile'],
	['monitor', 'upload'], ['b2', 'upload'], ['peer-fs', 'writeFile']
] as const;

function fixture(id: string, method?: 'writeFile' | 'upload') {
	const entries: ExplorerEntry[] = media.map(([name, fileType, contentType]) => ({ id: name, name, fileType, contentType, parentId: null, kind: 'file', size: 3 }));
	const saved = vi.fn(async (_parent: string | null, file: File) => ({ ...entries[0]!, name: file.name }));
	const read = vi.fn(async () => new Blob(['original']));
	const driver: ExplorerDriver = {
		id,
		capabilities: { supportsTrash: false, supportsSoftDelete: false, supportsRename: true,
			supportsMove: false, supportsCopy: false, supportsMkdir: false, supportsUpload: !!method,
			supportsDownload: true, supportsSiblingOrder: false },
		ready: async () => {}, list: async () => ({ entries, truncated: false }), getPath: async () => [],
		delete: async () => {}, readBlob: read, download: read,
		...(method ? { [method]: saved } : {})
	};
	return { driver, saved, read };
}

beforeEach(() => {
	for (const key of ['fe:previewDock', 'fe:showPreview', 'fe:viewMode', 'fe:showHidden']) persistKv.removeItem(key);
	Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
});

describe('preview quick-edit actions across connections', () => {
	it('refreshes the open Monitor preview pane after Quick edit overwrites the selected image', async () => {
		persistKv.setItem('fe:previewDock', 'bottom');
		const { driver } = fixture('monitor', 'upload');
		let entry: ExplorerEntry = { id: 'photo.png', name: 'photo.png', parentId: null, kind: 'file', fileType: 'image', size: 3, updatedAt: 1 };
		let changed: (() => void) | undefined;
		driver.list = async () => ({ entries: [entry], truncated: false });
		driver.thumbUrl = async () => ({ url: `${location.origin}/thumb?size=1024` });
		driver.subscribeChanges = (listener) => { changed = listener; return () => { changed = undefined; }; };
		driver.upload = async () => {
			entry = { ...entry, updatedAt: 2 };
			changed?.();
			return entry;
		};
		let context: QuickEditFileContext | undefined;
		render(FileExplorer, { props: { driver, mode: 'manage', onQuickEditImage: (_entry, ctx) => { context = ctx; } } });
		await waitFor(() => expect(document.querySelector('[data-testid="fe-file-row"][data-name="photo.png"]')).not.toBeNull());
		await fireEvent.click(document.querySelector('[data-testid="fe-file-row"][data-name="photo.png"]')!);
		const dock = await screen.findByTestId('fe-preview-dock');
		const version = () => {
			const src = dock.querySelector('img.fe-float-image')?.getAttribute('src');
			return src ? new URL(src).searchParams.get('v') : null;
		};
		await waitFor(() => expect(version()).toBe('m:3:1'));
		await fireEvent.click(within(dock).getByTestId('fe-preview-actions'));
		await fireEvent.click(screen.getByTestId('fe-file-preview-quick-edit'));
		expect(context).toBeDefined();
		await context!.save(new File(['new'], 'photo.png', { type: 'image/png' }));
		await waitFor(() => expect(version()).toBe('m:3:2'));
		expect(screen.getByTestId('fe-preview-dock')).toBe(dock);
	});

	for (const [connection, method] of connections) {
		for (const [name, kind] of media) {
			it(`${connection} offers ${kind} Quick edit and saves through ${method}`, async () => {
				const { driver, saved, read } = fixture(connection, method);
				let context: QuickEditFileContext | undefined;
				const edit = vi.fn((_entry: ExplorerEntry, ctx: QuickEditFileContext) => { context = ctx; });
				render(FileExplorer, { props: { driver, mode: 'manage', onQuickEditImage: edit, onQuickEditVideo: edit, onQuickEditAudio: edit, onQuickConvertSvg: vi.fn() } });
				await waitFor(() => expect(document.querySelector(`[data-testid="fe-file-row"][data-name="${name}"]`)).not.toBeNull());
				await fireEvent.click(document.querySelector(`[data-testid="fe-file-row"][data-name="${name}"]`)!);
				await fireEvent.click(screen.getByTestId('fe-item-details'));
				await screen.findByTestId('fe-file-preview');
				await fireEvent.click(screen.getByTestId('fe-preview-actions'));
				const menu = within(screen.getByTestId('fe-preview-actions-menu'));
				expect((menu.getByTestId('fe-file-preview-quick-edit') as HTMLButtonElement).disabled).toBe(false);
				expect((menu.getByTestId('fe-file-preview-compress') as HTMLButtonElement).disabled).toBe(false);
				expect((menu.getByTestId('fe-file-preview-encrypt') as HTMLButtonElement).disabled).toBe(false);
				if (kind === 'image') expect((menu.getByTestId('fe-file-preview-convert-svg') as HTMLButtonElement).disabled).toBe(false);
				await fireEvent.click(menu.getByTestId('fe-file-preview-quick-edit'));
				expect(edit).toHaveBeenCalledTimes(1);
				await context!.read();
				expect(read).toHaveBeenCalledWith(name);
				const output = new File(['edited'], 'edited-file');
				await context!.save(output);
				expect(saved).toHaveBeenCalledWith(null, output);
			});
		}
	}

	it('offers upload-backed Convert to SVG in the dock and keeps its original connection', async () => {
		persistKv.setItem('fe:previewDock', 'bottom');
		const original = fixture('monitor', 'upload');
		const next = fixture('b2', 'upload');
		let context: QuickEditFileContext | undefined;
		const props = { driver: original.driver, mode: 'manage' as const, onQuickConvertSvg: (_entry: ExplorerEntry, ctx: QuickEditFileContext) => { context = ctx; } };
		const view = render(FileExplorer, { props });
		await waitFor(() => expect(document.querySelector('[data-name="photo.png"]')).not.toBeNull());
		await fireEvent.click(document.querySelector('[data-testid="fe-file-row"][data-name="photo.png"]')!);
		await fireEvent.click(await screen.findByTestId('fe-preview-actions'));
		await fireEvent.click(screen.getByTestId('fe-file-preview-convert-svg'));
		await view.rerender({ ...props, driver: next.driver });
		await context!.read();
		await context!.save(new File(['svg'], 'photo.svg'));
		expect(original.read).toHaveBeenCalledWith('photo.png');
		expect(original.saved).toHaveBeenCalledTimes(1);
		expect(next.read).not.toHaveBeenCalled();
		expect(next.saved).not.toHaveBeenCalled();
	});

	it('keeps media actions visible with a reason on a read-only device connection', async () => {
		const { driver } = fixture('peer-fs');
		render(FileExplorer, { props: { driver, mode: 'manage', onQuickEditImage: vi.fn(), onQuickConvertSvg: vi.fn() } });
		await waitFor(() => expect(document.querySelector('[data-name="photo.png"]')).not.toBeNull());
		await fireEvent.click(document.querySelector('[data-testid="fe-file-row"][data-name="photo.png"]')!);
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		await screen.findByTestId('fe-file-preview');
		await fireEvent.click(screen.getByTestId('fe-preview-actions'));
		for (const id of ['fe-file-preview-quick-edit', 'fe-file-preview-convert-svg']) {
			const action = screen.getByTestId(id);
			expect((action as HTMLButtonElement).disabled).toBe(true);
			expect(action.getAttribute('title')).toMatch(/cannot save/);
		}
		expect((screen.getByTestId('fe-file-preview-compress') as HTMLButtonElement).disabled).toBe(false);
	});
});
