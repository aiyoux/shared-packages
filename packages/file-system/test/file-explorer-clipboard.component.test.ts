import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { appClipboard, persistKv, resetLayoutIdsForTests, toast } from '@shared-packages/ui';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import DualPaneExplorer from '../src/ui/DualPaneExplorer.svelte';
import { defaultFileWindows, saveFileWindows } from '../src/ui/fileWindows.ts';
import { FILE_CLIPBOARD_TYPE, FILE_CLIPBOARD_WEB_TYPE, fileClipboardPayload, fileClipboardFromHtml } from '../src/ui/fileClipboard.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

function backend(id = 'test-source') {
	const entries: ExplorerEntry[] = [
		{ id: 'file-1', name: 'one.txt', kind: 'file', parentId: null },
		{ id: 'file-2', name: 'two.txt', kind: 'file', parentId: null },
		{ id: 'target', name: 'Target', kind: 'folder', parentId: null }
	];
	const driver: ExplorerDriver = {
		id, connectionId: id,
		capabilities: {
			supportsTrash: false, supportsSoftDelete: false, supportsRename: true,
			supportsMove: true, supportsCopy: true, supportsMkdir: true,
			supportsUpload: true, supportsDownload: true, supportsSiblingOrder: false
		},
		ready: async () => {},
		list: async ({ parentId }) => ({ entries: entries.filter((e) => e.parentId === parentId), truncated: false }),
		getPath: async () => [],
		readBlob: async () => new Blob(['contents'], { type: 'text/plain' }),
		delete: vi.fn(async (entryId: string) => {
			entries.splice(entries.findIndex((e) => e.id === entryId), 1);
		}),
		move: vi.fn(async (entryId, parentId) => { entries.find((e) => e.id === entryId)!.parentId = parentId; }),
		copy: vi.fn(async (entryId, parentId) => {
			entries.push({ ...entries.find((e) => e.id === entryId)!, id: `copy-${entries.length}`, parentId });
		}),
		writeFile: vi.fn(async (parentId, file) => {
			const entry: ExplorerEntry = { id: `write-${entries.length}`, name: file.name, kind: 'file', parentId };
			entries.push(entry);
			return entry;
		})
	};
	return { entries, driver };
}

describe('FileExplorer clipboard', () => {
	let systemText = '';
	let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

	beforeEach(() => {
		appClipboard.clear();
		appClipboard.syncWithSystem = false;
		resetLayoutIdsForTests();
		persistKv.removeItem('fe:previewDock');
		persistKv.removeItem('fe:viewMode');
		systemText = '';
		writeText = vi.fn(async (text: string) => { systemText = text; });
		const clipboard = { writeText, readText: vi.fn(async () => systemText) };
		vi.stubGlobal('navigator', new Proxy(navigator, {
			get(target, key) { return key === 'clipboard' ? clipboard : Reflect.get(target, key, target); }
		}));
	});

	afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); appClipboard.clear(); });

	async function explorer(driver: ExplorerDriver, initialParentId: string | null = null) {
		const view = render(FileExplorer, { props: { driver, mode: 'manage', variant: 'panel', initialParentId } });
		const root = within(view.container).getByTestId('file-explorer');
		await waitFor(() => expect(root.querySelector('[data-testid="fe-list"]')).toBeTruthy());
		return { view, root, ui: within(root) };
	}

	async function select(root: HTMLElement, id = 'file-1') {
		await waitFor(() => expect(root.querySelector(`[data-id="${id}"]`)).toBeTruthy());
		await fireEvent.click(root.querySelector(`[data-id="${id}"]`)!);
	}

	function imageClipboard() {
		let items: ClipboardItem[] = [];
		class NativeItem {
			static supports(type: string) { return type === 'image/png' || type === FILE_CLIPBOARD_WEB_TYPE; }
			readonly types: string[];
			constructor(private data: Record<string, Blob | Promise<Blob>>) { this.types = Object.keys(data); }
			async getType(type: string) { return this.data[type]; }
		}
		vi.stubGlobal('ClipboardItem', NativeItem);
		const write = vi.fn(async (next: ClipboardItem[]) => {
			for (const item of next) for (const type of item.types) await item.getType(type);
			items = next;
			systemText = next[0]?.types.includes('text/plain') ? await (await next[0].getType('text/plain')).text() : '';
		});
		const clipboard = { write, writeText: async (text: string) => {
			await writeText(text);
			items = text ? [new NativeItem({ 'text/plain': new Blob([text], { type: 'text/plain' }) }) as unknown as ClipboardItem] : [];
		}, read: vi.fn(async () => items), readText: vi.fn(async () => systemText) };
		vi.stubGlobal('navigator', new Proxy(navigator, {
			get(target, key) { return key === 'clipboard' ? clipboard : Reflect.get(target, key, target); }
		}));
		return { write, setItems: (next: ClipboardItem[]) => { items = next; } };
	}

	it.each(['local', 'monitor', 'b2'])('copies %s folders with readable text and recovers references on native Paste', async (connection) => {
		const { write } = imageClipboard();
		const { driver, entries } = backend(connection);
		entries.push({ id: 'folder-a', name: 'Docs & <notes>"', parentId: null, kind: 'folder' });
		const source = await explorer(driver);
		const dest = await explorer(driver, 'target');
		await select(source.root, 'folder-a');
		await fireEvent.click(source.ui.getByTestId('fe-copy'));
		await waitFor(() => expect(systemText).toBe('Docs & <notes>"'));
		expect(writeText).not.toHaveBeenCalled();
		const item = (await navigator.clipboard.read())[0];
		const html = await (await item.getType('text/html')).text();
		expect(new DOMParser().parseFromString(html, 'text/html').body.textContent).toBe(systemText);
		expect(fileClipboardFromHtml(html)?.ids).toEqual(['folder-a']);
		// Native paste receives HTML metadata even when web custom formats are hidden.
		appClipboard.clear();
		const event = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', { value: {
			files: { length: 0 }, items: [], getData: (type: string) => type === 'text/html' ? html : type === 'text/plain' ? systemText : ''
		} });
		dest.root.dispatchEvent(event);
		await waitFor(() => expect(driver.copy).toHaveBeenCalledWith('folder-a', 'target'));
		expect(driver.writeFile).not.toHaveBeenCalled();
		// History re-copy retains formats rather than serializing the stored object.
		expect(await appClipboard.copyToSystem(appClipboard.current!)).toBe(true);
		expect(write).toHaveBeenCalledTimes(2);
		expect(systemText).toBe('Docs & <notes>"');
	});

	it('uses HTML references across tabs when custom web formats are unsupported', async () => {
		imageClipboard();
		vi.spyOn(ClipboardItem, 'supports').mockReturnValue(false);
		const { driver } = backend();
		const source = await explorer(driver);
		const dest = await explorer(driver, 'target');
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-copy'));
		await waitFor(() => expect(systemText).toBe('one.txt'));
		expect((await navigator.clipboard.read())[0].types).toEqual(['text/plain', 'text/html']);
		appClipboard.clear();
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(driver.copy).toHaveBeenCalledWith('file-1', 'target'));
		expect(driver.writeFile).not.toHaveBeenCalled();
	});

	it('keeps native clipboard cut metadata synchronized through partial and completed moves', async () => {
		imageClipboard();
		const { driver } = backend();
		const source = await explorer(driver);
		const dest = await explorer(driver, 'target');
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-select-multi'));
		await select(source.root, 'file-2');
		await fireEvent.click(source.ui.getByTestId('fe-cut'));
		await waitFor(() => expect(systemText).toBe('one.txt\ntwo.txt'));
		vi.mocked(driver.move!).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second failed'));
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(systemText).toBe('two.txt'));
		expect(fileClipboardFromHtml(await (await (await navigator.clipboard.read())[0].getType('text/html')).text())?.ids).toEqual(['file-2']);
		await waitFor(() => expect((dest.ui.getByTestId('fe-paste') as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(systemText).toBe(''));
		expect(await navigator.clipboard.read()).toEqual([]);
		expect(fileClipboardPayload(appClipboard.current?.data)?.ids).toEqual([]);
	});

	it.each(['monitor', 'b2'])('copies actual %s image bytes and preserves the original file reference for Paste', async (connection) => {
		const { write } = imageClipboard();
		const { driver, entries } = backend(connection);
		entries[0].name = 'photo.png';
		const png = new Blob(['native PNG bytes'], { type: 'application/octet-stream' });
		let finishDownload!: (blob: Blob) => void;
		const download = new Promise<Blob>((resolve) => { finishDownload = resolve; });
		delete driver.readBlob;
		driver.download = vi.fn(async () => download);
		const source = await explorer(driver);
		const dest = await explorer(driver, 'target');
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-copy'));
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
		expect(fileClipboardPayload(appClipboard.current?.data)?.ids).toEqual(['file-1']);
		finishDownload(png);
		await waitFor(async () => expect((await navigator.clipboard.read())[0]?.types).toContain('image/png'));
		const item = (await navigator.clipboard.read())[0];
		expect(item.types).toEqual(['image/png', FILE_CLIPBOARD_WEB_TYPE]);
		expect(await (await item.getType('image/png')).text()).toBe('native PNG bytes');
		expect(driver.download).toHaveBeenCalledWith('file-1');
		expect(writeText).not.toHaveBeenCalled();
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(driver.copy).toHaveBeenCalledWith('file-1', 'target'));
		expect(driver.writeFile).not.toHaveBeenCalled();
		// Native paste does not expose custom web MIME; recover refs from the matching image.
		const event = new Event('paste', { bubbles: true, cancelable: true });
		const file = new File(['native PNG bytes'], 'image.png', { type: 'image/png' });
		Object.defineProperty(event, 'clipboardData', { value: {
			files: { length: 1, item: () => file }, items: [], getData: () => ''
		} });
		dest.root.dispatchEvent(event);
		await waitFor(() => expect(driver.copy).toHaveBeenCalledTimes(2));
		expect(driver.writeFile).not.toHaveBeenCalled();
	});

	it('reports image clipboard failures without replacing the image with JSON text', async () => {
		const report = vi.spyOn(toast, 'error');
		const { write } = imageClipboard();
		write.mockRejectedValue(new Error('NotAllowedError'));
		const { driver, entries } = backend('monitor');
		entries[0].name = 'photo.png';
		driver.readBlob = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
		const source = await explorer(driver);
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-copy'));
		await waitFor(() => expect(report).toHaveBeenCalledWith(expect.stringContaining('Could not copy image to the system clipboard')));
		expect(writeText).not.toHaveBeenCalled();
		expect(fileClipboardPayload(appClipboard.current?.data)?.ids).toEqual(['file-1']);
	});

	it('imports an external image instead of using stale image references', async () => {
		const { write, setItems } = imageClipboard();
		const { driver, entries } = backend();
		entries[0].name = 'photo.png';
		driver.readBlob = async () => new Blob(['original'], { type: 'image/png' });
		const source = await explorer(driver);
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-copy'));
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
		await waitFor(async () => expect((await navigator.clipboard.read())[0]?.types).toContain(FILE_CLIPBOARD_WEB_TYPE));
		setItems([new ClipboardItem({ 'image/png': new Blob(['external'], { type: 'image/png' }) })]);
		await fireEvent.click(source.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(driver.writeFile).toHaveBeenCalledTimes(1));
		expect(driver.copy).not.toHaveBeenCalled();
		expect(vi.mocked(driver.writeFile!).mock.calls[0][1].type).toBe('image/png');
	});

	it('uses the native image snapshot when async clipboard metadata belongs to another image', async () => {
		const { write } = imageClipboard();
		const { driver, entries } = backend();
		entries[0].name = 'photo.png';
		driver.readBlob = async () => new Blob(['original'], { type: 'image/png' });
		const source = await explorer(driver);
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-copy'));
		await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
		await waitFor(async () => expect((await navigator.clipboard.read())[0]?.types).toContain(FILE_CLIPBOARD_WEB_TYPE));
		const event = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', { value: {
			files: { length: 1, item: () => new File(['external'], 'pasted.png', { type: 'image/png' }) },
			items: [], getData: () => ''
		} });
		source.root.dispatchEvent(event);
		await waitFor(() => expect(driver.writeFile).toHaveBeenCalledTimes(1));
		expect(driver.copy).not.toHaveBeenCalled();
		expect(vi.mocked(driver.writeFile!).mock.calls[0][1].name).toBe('pasted.png');
	});

	it('still writes native image data when custom clipboard formats are unsupported', async () => {
		const { write } = imageClipboard();
		vi.spyOn(ClipboardItem, 'supports').mockImplementation((type) => type === 'image/png');
		const { driver, entries } = backend();
		entries[0].name = 'photo.png';
		driver.readBlob = async () => new Blob(['original'], { type: 'image/png' });
		const source = await explorer(driver);
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-copy'));
		await waitFor(async () => expect((await navigator.clipboard.read())[0]?.types).toEqual(['image/png']));
		expect(write).toHaveBeenCalledTimes(1);
		expect(writeText).not.toHaveBeenCalled();
	});

	it('details Copy syncs file references and Paste copies repeatedly in another pane', async () => {
		const { driver, entries } = backend();
		const source = await explorer(driver);
		const dest = await explorer(driver, 'target');
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-item-details'));
		await waitFor(() => expect(document.querySelector('[data-testid="fe-file-preview"] [data-testid="fe-row-copy"]')).toBeTruthy());
		await fireEvent.click(document.querySelector('[data-testid="fe-file-preview"] [data-testid="fe-row-copy"]')!);
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(driver.copy).not.toHaveBeenCalled();
		expect(systemText).toBe('one.txt');
		await waitFor(() => expect((dest.ui.getByTestId('fe-paste') as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(driver.copy).toHaveBeenCalledTimes(1));
		await waitFor(() => expect((dest.ui.getByTestId('fe-paste') as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(driver.copy).toHaveBeenCalledTimes(2));
		expect(entries.find((e) => e.id === 'file-1')?.parentId).toBeNull();
	});

	it('single-item Cut waits for Paste, marks the source, and consumes the completed move', async () => {
		const { driver, entries } = backend();
		const source = await explorer(driver);
		const dest = await explorer(driver, 'target');
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-item-details'));
		await waitFor(() => expect(document.querySelector('[data-testid="fe-file-preview"] [data-testid="fe-cut"]')).toBeTruthy());
		await fireEvent.click(document.querySelector('[data-testid="fe-file-preview"] [data-testid="fe-cut"]')!);
		await waitFor(() => expect(source.root.querySelector('[data-id="file-1"]')?.classList.contains('fe-cut-pending')).toBe(true));
		expect(driver.move).not.toHaveBeenCalled();
		expect(entries.find((e) => e.id === 'file-1')?.parentId).toBeNull();
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(fileClipboardPayload(appClipboard.current?.data)?.ids).toEqual([]));
		expect(driver.move).toHaveBeenCalledWith('file-1', 'target');
		expect(systemText).toBe('');
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		expect(driver.move).toHaveBeenCalledTimes(1);
	});

	it('keeps only failed cut items after a partial move', async () => {
		const { driver } = backend();
		const source = await explorer(driver);
		const dest = await explorer(driver, 'target');
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-select-multi'));
		await select(source.root, 'file-2');
		vi.mocked(driver.move!).mockRejectedValueOnce(new Error('move failed'));
		await fireEvent.click(source.ui.getByTestId('fe-cut'));
		await waitFor(() => expect(fileClipboardPayload(appClipboard.current?.data)?.ids).toHaveLength(2));
		// First attempt fails without consuming anything; second moves the first and fails the second.
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(driver.move).toHaveBeenCalledTimes(1));
		expect(fileClipboardPayload(appClipboard.current?.data)?.ids).toHaveLength(2);
		await waitFor(() => expect((dest.ui.getByTestId('fe-paste') as HTMLButtonElement).disabled).toBe(false));
		vi.mocked(driver.move!).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second failed'));
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(fileClipboardPayload(appClipboard.current?.data)?.ids).toEqual(['file-2']));
		expect(systemText).toBe('two.txt');
	});

	it('pastes the latest system text instead of an older copied file', async () => {
		const { driver } = backend();
		const source = await explorer(driver);
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-copy'));
		await waitFor(() => expect(writeText).toHaveBeenCalled());
		systemText = 'new system text';
		await fireEvent.click(source.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(driver.writeFile).toHaveBeenCalled());
		expect(driver.copy).not.toHaveBeenCalled();
		expect(vi.mocked(driver.writeFile!).mock.calls[0][1].name).toBe('new system text.txt');
		expect(writeText).toHaveBeenCalledTimes(1);
	});

	it('retains a usable file clipboard when browser clipboard permission is denied', async () => {
		const { driver } = backend();
		const source = await explorer(driver);
		const dest = await explorer(driver, 'target');
		writeText.mockRejectedValue(new Error('NotAllowedError'));
		vi.mocked(navigator.clipboard.readText).mockRejectedValue(new Error('NotAllowedError'));
		await select(source.root);
		await fireEvent.click(source.ui.getByTestId('fe-cut'));
		await waitFor(() => expect((dest.ui.getByTestId('fe-paste') as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(dest.ui.getByTestId('fe-paste'));
		await waitFor(() => expect(fileClipboardPayload(appClipboard.current?.data)?.ids).toEqual([]));
		expect(driver.move).toHaveBeenCalledWith('file-1', 'target');
	});

	it('imports native paste files into only the receiving pane and leaves text inputs alone', async () => {
		const { driver } = backend();
		const source = await explorer(driver);
		const dest = await explorer(driver, 'target');
		const file = new File(['external'], 'external.txt', { type: 'text/plain' });
		const paste = () => {
			const event = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clipboardData', { value: {
				files: { length: 1, item: () => file }, items: [], getData: () => ''
			} });
			return event;
		};
		const input = document.createElement('textarea');
		source.root.append(input);
		input.dispatchEvent(paste());
		expect(driver.writeFile).not.toHaveBeenCalled();
		dest.root.dispatchEvent(paste());
		await waitFor(() => expect(driver.writeFile).toHaveBeenCalledTimes(1));
		expect(vi.mocked(driver.writeFile!).mock.calls[0][0]).toBe('target');
	});

	it.each(['c', 'x'])('Ctrl+%s loads the shared clipboard and does not intercept an editor', async (key) => {
		const { driver } = backend();
		const source = await explorer(driver);
		await select(source.root);
		await fireEvent.keyDown(source.root, { key, ctrlKey: true });
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(systemText).toBe('one.txt');
		expect(fileClipboardPayload(appClipboard.current?.data)?.mode).toBe(key === 'x' ? 'cut' : 'copy');
		const editor = document.createElement('div');
		editor.setAttribute('contenteditable', 'true');
		source.root.append(editor);
		await fireEvent.keyDown(editor, { key, ctrlKey: true });
		expect(writeText).toHaveBeenCalledTimes(1);
	});

	it.each(['success', 'copy-failure', 'delete-failure', 'flat-source'])('cross-connection cut handles %s', async (outcome) => {
		const source = backend(outcome === 'flat-source' ? 'memory' : 'local');
		const dest = backend('test-remote');
		dest.entries.splice(0);
		if (outcome === 'copy-failure') vi.mocked(dest.driver.writeFile!).mockRejectedValue(new Error('destination failed'));
		if (outcome === 'delete-failure') vi.mocked(source.driver.delete).mockRejectedValue(new Error('delete failed'));
		if (outcome === 'flat-source') {
			source.driver.capabilities.supportsMove = false;
			source.driver.capabilities.supportsCopy = false;
		}
		const dualPaneKey = `clipboard:${Math.random()}`;
		saveFileWindows(dualPaneKey, {
			root: { kind: 'split', id: 'clipboard-split', direction: 'row', ratio: 0.5,
				first: { kind: 'leaf', id: 'left' }, second: { kind: 'leaf', id: 'right' } },
			windows: defaultFileWindows(), focusedId: 'left', targetPaneId: 'right'
		});
		const view = render(DualPaneExplorer, { props: {
			localDriver: source.driver, overrideRight: { driver: dest.driver, label: 'Destination' },
			dualPaneDefault: true, dualPaneKey, hideToggles: true
		} });
		await waitFor(() => expect(view.container.querySelector('[data-pane="left"] [data-id="file-1"]')).toBeTruthy());
		const left = view.container.querySelector('[data-pane="left"]') as HTMLElement;
		const right = view.container.querySelector('[data-pane="right"]') as HTMLElement;
		await select(left);
		await fireEvent.click(within(left).getByTestId('fe-cut'));
		await waitFor(() => expect((within(right).getByTestId('fe-paste') as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(within(right).getByTestId('fe-paste'));
		await waitFor(() => expect(dest.driver.writeFile).toHaveBeenCalled());
		if (outcome === 'copy-failure' || outcome === 'delete-failure') {
			if (outcome === 'copy-failure') expect(source.driver.delete).not.toHaveBeenCalled();
			else await waitFor(() => expect(source.driver.delete).toHaveBeenCalledWith('file-1'));
			expect(fileClipboardPayload(appClipboard.current?.data)?.ids).toEqual(['file-1']);
			expect(source.entries.some((entry) => entry.id === 'file-1')).toBe(true);
		} else {
			await waitFor(() => expect(source.driver.delete).toHaveBeenCalledWith('file-1'));
			await waitFor(() => expect(fileClipboardPayload(appClipboard.current?.data)?.ids ?? []).toEqual([]));
			expect(dest.entries[0].name).toBe('one.txt');
		}
		if (outcome === 'copy-failure' || outcome === 'delete-failure') {
			expect(appClipboard.current?.type).toBe(FILE_CLIPBOARD_TYPE);
		} else expect(systemText).toBe('');
	});
});
