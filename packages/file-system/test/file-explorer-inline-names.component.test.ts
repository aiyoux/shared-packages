import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { persistKv, toast } from '@shared-packages/ui';
import { createVfs, resetSharedVfsForTests, type VfsService } from '../src/index.ts';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';

let vfs: VfsService;
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
	resetSharedVfsForTests();
	for (const key of ['previewDock', 'viewMode', 'sort', 'columns', 'folderStacks', 'showHidden', 'treeDock', 'selectMulti']) persistKv.removeItem(`fe:${key}`);
	Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
	vfs = createVfs({ dbName: `fe-inline-${crypto.randomUUID()}`, memoryOpfs: true, requestPersist: false });
	await vfs.ready();
});

async function mount(dock: 'off' | 'right' = 'off') {
	persistKv.setItem('fe:previewDock', dock);
	const driver = createLocalExplorerDriver(vfs);
	const createFolder = driver.mkdir!.bind(driver);
	const mkdir = vi.spyOn(driver, 'mkdir');
	const rename = vi.spyOn(driver, 'rename');
	const view = render(FileExplorer, { props: { driver, vfs, mode: 'manage', variant: 'panel', showPersistence: false } });
	await waitFor(() => expect(screen.getByTestId('fe-list').getAttribute('aria-busy')).not.toBe('true'));
	return { view, driver, mkdir, rename, createFolder };
}

async function selectFile() {
	const row = await screen.findByTestId('fe-file-row');
	await fireEvent.click(row);
	return row;
}

describe('inline folder creation', () => {
	it.each(['list', 'icons', 'detailed'])('creates from a focused draft row in %s view only after clicking outside', async (mode) => {
		persistKv.setItem('fe:viewMode', mode);
		const { mkdir } = await mount();
		await fireEvent.click(screen.getByTestId('fe-new-folder'));
		const input = await screen.findByTestId('fe-new-folder-input') as HTMLInputElement;
		const draft = screen.getByTestId('fe-new-folder-row');
		expect(screen.getByTestId('fe-list').contains(draft)).toBe(true);
		expect(draft.contains(input)).toBe(true);
		expect(screen.queryByTestId('fe-new-folder-form')).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe(input.value.length);
		expect(await vfs.list({ parentId: null })).toHaveLength(0);
		expect(mkdir).not.toHaveBeenCalled();
		await fireEvent.input(input, { target: { value: '  Draft folder  ' } });
		await fireEvent.pointerDown(screen.getByTestId('fe-list'));
		await waitFor(() => expect(screen.queryByTestId('fe-new-folder-row')).toBeNull());
		expect(mkdir).toHaveBeenCalledExactlyOnceWith(null, 'Draft folder');
		expect((await vfs.list({ parentId: null })).map((n) => n.name)).toEqual(['Draft folder']);
		expect(screen.getByTestId('fe-folder-row').getAttribute('data-name')).toBe('Draft folder');
	});

	it.each(['cancel', 'escape', 'blank'])('does not create a folder when the draft is %s', async (method) => {
		const { mkdir } = await mount();
		await fireEvent.click(screen.getByTestId('fe-new-folder'));
		const input = await screen.findByTestId('fe-new-folder-input');
		await fireEvent.input(input, { target: { value: method === 'blank' ? '   ' : 'Discard me' } });
		if (method === 'cancel') {
			await fireEvent.pointerDown(screen.getByTestId('fe-new-folder-cancel'));
			await fireEvent.click(screen.getByTestId('fe-new-folder-cancel'));
		} else if (method === 'escape') await fireEvent.keyDown(input, { key: 'Escape' });
		else await fireEvent.pointerDown(screen.getByTestId('fe-list'));
		await waitFor(() => expect(screen.queryByTestId('fe-new-folder-input')).toBeNull());
		expect(await vfs.list({ parentId: null })).toHaveLength(0);
		expect(mkdir).not.toHaveBeenCalled();
	});

	it('keeps the draft editable after a failed create and retries once', async () => {
		const errorToast = vi.spyOn(toast, 'error').mockReturnValue(0);
		const { mkdir } = await mount();
		mkdir.mockRejectedValueOnce(new Error('Create refused'));
		await fireEvent.click(screen.getByTestId('fe-new-folder'));
		await fireEvent.input(screen.getByTestId('fe-new-folder-input'), { target: { value: 'Retry' } });
		await fireEvent.click(screen.getByTestId('fe-new-folder-confirm'));
		await waitFor(() => expect(errorToast).toHaveBeenCalledWith('Create refused'));
		expect((screen.getByTestId('fe-new-folder-input') as HTMLInputElement).value).toBe('Retry');
		await waitFor(() => expect((screen.getByTestId('fe-new-folder-confirm') as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.keyDown(screen.getByTestId('fe-new-folder-input'), { key: 'Enter' });
		await waitFor(() => expect(screen.queryByTestId('fe-new-folder-row')).toBeNull());
		expect(mkdir).toHaveBeenCalledTimes(2);
		expect((await vfs.list({ parentId: null })).map((n) => n.name)).toEqual(['Retry']);
	});

	it('creates the default name once while repeated saves are pending', async () => {
		const { mkdir, createFolder } = await mount();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		mkdir.mockImplementationOnce(async (...args) => {
			await pending;
			return createFolder(...args);
		});
		await fireEvent.click(screen.getByTestId('fe-new-folder'));
		await fireEvent.keyDown(screen.getByTestId('fe-new-folder-input'), { key: 'Enter' });
		await fireEvent.pointerDown(screen.getByTestId('fe-list'));
		await fireEvent.keyDown(screen.getByTestId('fe-new-folder-input'), { key: 'Enter' });
		expect(mkdir).toHaveBeenCalledExactlyOnceWith(null, 'New Folder');
		expect((screen.getByTestId('fe-new-folder-input') as HTMLInputElement).disabled).toBe(true);
		expect(await vfs.list({ parentId: null })).toHaveLength(0);
		release();
		await waitFor(() => expect(screen.queryByTestId('fe-new-folder-row')).toBeNull());
		expect((await vfs.list({ parentId: null })).map((n) => n.name)).toEqual(['New Folder']);
		expect(screen.getAllByTestId('fe-folder-row')).toHaveLength(1);
		expect(mkdir).toHaveBeenCalledTimes(1);
	});

	it('discards an uncommitted draft when the connection changes', async () => {
		const { view, driver, mkdir } = await mount();
		await fireEvent.click(screen.getByTestId('fe-new-folder'));
		await fireEvent.input(screen.getByTestId('fe-new-folder-input'), { target: { value: 'Never create' } });
		await view.rerender({ driver: { ...driver, id: 'other' } });
		expect(screen.queryByTestId('fe-new-folder-row')).toBeNull();
		expect(mkdir).not.toHaveBeenCalled();
		expect(await vfs.list({ parentId: null })).toHaveLength(0);
	});
});

describe('shared listing and preview rename', () => {
	it('shares edits both ways and keeps editing when focus moves between the two inputs', async () => {
		const file = await vfs.writeFile({ parentId: null, name: 'Original.txt', body: 'text' });
		const { rename } = await mount('right');
		await selectFile();
		const toolbar = screen.getByTestId('fe-selection-actions');
		await fireEvent.click(toolbar.querySelector('[data-testid="fe-rename-btn"]')!);
		const listing = await screen.findByTestId('fe-rename-input') as HTMLInputElement;
		const preview = await screen.findByTestId('fe-preview-rename-input') as HTMLInputElement;
		await waitFor(() => expect(document.activeElement).toBe(listing));
		await fireEvent.input(listing, { target: { value: 'From listing.txt' } });
		expect(preview.value).toBe('From listing.txt');
		await fireEvent.pointerDown(preview);
		preview.focus();
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		expect(rename).not.toHaveBeenCalled();
		await fireEvent.input(preview, { target: { value: 'From preview.txt' } });
		expect(listing.value).toBe('From preview.txt');
		await fireEvent.pointerDown(listing);
		listing.focus();
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		expect(rename).not.toHaveBeenCalled();
		await fireEvent.pointerDown(screen.getByTestId('fe-list'));
		await waitFor(() => expect(screen.queryByTestId('fe-preview-rename-input')).toBeNull());
		expect(rename).toHaveBeenCalledExactlyOnceWith(file.id, 'From preview.txt');
		expect(screen.getByTestId('fe-file-preview-name').textContent).toBe('From preview.txt');
		expect(screen.getByTestId('fe-file-row').getAttribute('data-name')).toBe('From preview.txt');
	});

	it.each(['cancel', 'escape', 'blank'])('the preview pencil starts both editors and %s preserves the original name', async (method) => {
		await vfs.writeFile({ parentId: null, name: 'Keep.txt', body: 'text' });
		const { rename } = await mount('right');
		await selectFile();
		await fireEvent.click(screen.getByTestId('fe-preview-rename'));
		const preview = await screen.findByTestId('fe-preview-rename-input') as HTMLInputElement;
		await waitFor(() => expect(document.activeElement).toBe(preview));
		expect(screen.getByTestId('fe-rename-input')).toBeTruthy();
		await fireEvent.input(preview, { target: { value: method === 'blank' ? ' ' : 'Changed.txt' } });
		if (method === 'cancel') {
			await fireEvent.pointerDown(screen.getByTestId('fe-preview-rename-cancel'));
			await fireEvent.click(screen.getByTestId('fe-preview-rename-cancel'));
		} else if (method === 'escape') await fireEvent.keyDown(preview, { key: 'Escape' });
		else await fireEvent.keyDown(preview, { key: 'Enter' });
		await waitFor(() => expect(screen.queryByTestId('fe-preview-rename-input')).toBeNull());
		expect(screen.queryByTestId('fe-rename-input')).toBeNull();
		expect(rename).not.toHaveBeenCalled();
		expect(screen.getByTestId('fe-file-preview-name').textContent).toBe('Keep.txt');
	});

	it('keeps popup preview open when its Rename tool is used and updates its title after save', async () => {
		const file = await vfs.writeFile({ parentId: null, name: 'Popup.txt', body: 'text' });
		const { rename } = await mount();
		await selectFile();
		await fireEvent.click(screen.getByTestId('fe-item-details'));
		const popup = await screen.findByTestId('fe-file-preview');
		await fireEvent.click(popup.querySelector('[data-testid="fe-rename-btn"]')!);
		expect(screen.getByTestId('fe-file-preview')).toBe(popup);
		const preview = await screen.findByTestId('fe-preview-rename-input');
		await fireEvent.input(preview, { target: { value: 'Renamed popup.txt' } });
		expect((screen.getByTestId('fe-rename-input') as HTMLInputElement).value).toBe('Renamed popup.txt');
		await fireEvent.click(screen.getByTestId('fe-preview-rename-ok'));
		await waitFor(() => expect(screen.queryByTestId('fe-preview-rename-input')).toBeNull());
		expect(rename).toHaveBeenCalledExactlyOnceWith(file.id, 'Renamed popup.txt');
		expect(screen.getByTestId('fe-file-preview-name').textContent).toBe('Renamed popup.txt');
		expect(screen.getByTestId('fe-file-preview')).toBe(popup);
	});

	it('hides the pencil for read-only and multi-selection previews', async () => {
		await vfs.writeFile({ parentId: null, name: 'A.txt', body: 'a' });
		await vfs.writeFile({ parentId: null, name: 'B.txt', body: 'b' });
		const { view, driver } = await mount('right');
		const rows = await screen.findAllByTestId('fe-file-row');
		await fireEvent.click(rows[0]!);
		await fireEvent.click(rows[1]!, { ctrlKey: true });
		expect(screen.queryByTestId('fe-preview-rename')).toBeNull();
		await fireEvent.click(rows[0]!);
		await view.rerender({ driver: { ...driver, capabilities: { ...driver.capabilities, supportsRename: false } } });
		expect(screen.queryByTestId('fe-preview-rename')).toBeNull();
	});
});
