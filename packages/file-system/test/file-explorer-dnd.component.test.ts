/**
 * FileExplorer DnD chrome + reorder commit path (jsdom).
 * Run: npm run test:component -w @shared-packages/file-system
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import {
	createVfs,
	resetSharedVfsForTests,
	type VfsService
} from '../src/index.ts';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';
import type { ExplorerDriver } from '../src/ui/explorerDriver.ts';

describe('FileExplorer DnD', () => {
	let vfs: VfsService;

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({
			dbName: `fe-dnd-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	it('ordered local rows expose dnd DOM contract and are draggable', async () => {
		await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'b' });
		const driver = createLocalExplorerDriver(vfs);
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		const root = await screen.findByTestId('file-explorer');
		expect(root.getAttribute('data-fe-backend')).toBe('local');
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 2);
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		expect(row.getAttribute('draggable')).toBe('true');
		expect(row.getAttribute('data-fe-row-id')).toBeTruthy();
		expect(row.getAttribute('data-fe-kind')).toBe('file');
		expect(row.hasAttribute('data-fe-sort-order')).toBe(true);
	});

	it('same-parent drop calls driver.reorder (not DOM-only)', async () => {
		const a = await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		const b = await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'b' });
		const base = createLocalExplorerDriver(vfs);
		const reorder = vi.fn(async (id: string, opts: { beforeId?: string | null; afterId?: string | null }) => {
			await base.reorder!(id, opts);
		});
		// Keep method identity stable for Svelte prop / effect (plain spread of class methods).
		const driver: ExplorerDriver = {
			id: base.id,
			capabilities: base.capabilities,
			ready: (...args) => base.ready(...args),
			list: (...args) => base.list(...args),
			getPath: (...args) => base.getPath(...args),
			mkdir: base.mkdir?.bind(base),
			rename: base.rename?.bind(base),
			move: base.move?.bind(base),
			copy: base.copy?.bind(base),
			delete: (...args) => base.delete(...args),
			restore: base.restore?.bind(base),
			permanentDelete: base.permanentDelete?.bind(base),
			emptyTrash: base.emptyTrash?.bind(base),
			reorder
		};
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 2);
		// Wait for list paint settle (aria-busy cleared)
		await viWaitFor(() => {
			const list = document.querySelector('[data-testid="fe-list"]');
			return list?.getAttribute('aria-busy') !== 'true';
		});

		const rows = Array.from(document.querySelectorAll('[data-testid="fe-file-row"]')) as HTMLElement[];
		const src = rows.find((r) => r.getAttribute('data-name') === 'b.txt')!;
		const tgt = rows.find((r) => r.getAttribute('data-name') === 'a.txt')!;
		expect(src.getAttribute('draggable')).toBe('true');

		const dt = {
			data: new Map<string, string>(),
			setData(type: string, val: string) {
				this.data.set(type, val);
			},
			getData(type: string) {
				return this.data.get(type) ?? '';
			},
			effectAllowed: 'all' as string,
			dropEffect: 'none' as string
		};

		// Native DragEvent path — testing-library fireEvent.drag* does not attach
		// dataTransfer reliably for Svelte 5 delegated handlers in jsdom.
		const rect = {
			top: 100,
			height: 40,
			bottom: 140,
			left: 0,
			right: 100,
			width: 100,
			x: 0,
			y: 100,
			toJSON: () => ({})
		};
		vi.spyOn(tgt, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);

		const startEv = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(startEv, 'dataTransfer', { value: dt });
		src.dispatchEvent(startEv);

		const overEv = new MouseEvent('dragover', {
			bubbles: true,
			cancelable: true,
			clientY: 105 // top 25% → before
		}) as DragEvent;
		Object.defineProperty(overEv, 'dataTransfer', { value: dt });
		tgt.dispatchEvent(overEv);

		await viWaitFor(() => document.querySelector('[data-testid="fe-dnd-line"]') != null);
		const line = document.querySelector('[data-testid="fe-dnd-line"]') as HTMLElement;
		expect(line.getAttribute('data-fe-dnd-zone')).toBe('before');
		const firstRow = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		expect(firstRow.previousElementSibling?.classList.contains('fe-dnd-line') ?? false).toBe(
			false
		);

		const dropEv = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(dropEv, 'dataTransfer', { value: dt });
		tgt.dispatchEvent(dropEv);

		await viWaitFor(() => reorder.mock.calls.length > 0);
		expect(reorder).toHaveBeenCalled();
		const call = reorder.mock.calls[0]!;
		expect(call[0]).toBe(b.id);
		// before zone → afterId = target (a)
		expect(call[1]).toMatchObject({ afterId: a.id });
	});

	it('drop on the middle of a file row reorders (no into-file dead zone)', async () => {
		const a = await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		const b = await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'b' });
		const base = createLocalExplorerDriver(vfs);
		const reorder = vi.fn(async (id: string, opts: { beforeId?: string | null; afterId?: string | null }) => {
			await base.reorder!(id, opts);
		});
		const driver: ExplorerDriver = {
			id: base.id,
			capabilities: base.capabilities,
			ready: (...args) => base.ready(...args),
			list: (...args) => base.list(...args),
			getPath: (...args) => base.getPath(...args),
			mkdir: base.mkdir?.bind(base),
			rename: base.rename?.bind(base),
			move: base.move?.bind(base),
			copy: base.copy?.bind(base),
			delete: (...args) => base.delete(...args),
			restore: base.restore?.bind(base),
			permanentDelete: base.permanentDelete?.bind(base),
			emptyTrash: base.emptyTrash?.bind(base),
			reorder
		};
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 2);
		await viWaitFor(() => {
			const list = document.querySelector('[data-testid="fe-list"]');
			return list?.getAttribute('aria-busy') !== 'true';
		});

		const rows = Array.from(document.querySelectorAll('[data-testid="fe-file-row"]')) as HTMLElement[];
		const src = rows.find((r) => r.getAttribute('data-name') === 'a.txt')!;
		const tgt = rows.find((r) => r.getAttribute('data-name') === 'b.txt')!;
		const dt = {
			data: new Map<string, string>(),
			setData(type: string, val: string) {
				this.data.set(type, val);
			},
			getData(type: string) {
				return this.data.get(type) ?? '';
			},
			effectAllowed: 'all' as string,
			dropEffect: 'none' as string
		};
		vi.spyOn(tgt, 'getBoundingClientRect').mockReturnValue({
			top: 100,
			height: 40,
			bottom: 140,
			left: 0,
			right: 100,
			width: 100,
			x: 0,
			y: 100,
			toJSON: () => ({})
		} as DOMRect);

		const startEv = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(startEv, 'dataTransfer', { value: dt });
		src.dispatchEvent(startEv);

		const overEv = new MouseEvent('dragover', {
			bubbles: true,
			cancelable: true,
			clientY: 125 // middle of file → after (not into)
		}) as DragEvent;
		Object.defineProperty(overEv, 'dataTransfer', { value: dt });
		tgt.dispatchEvent(overEv);

		const dropEv = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(dropEv, 'dataTransfer', { value: dt });
		tgt.dispatchEvent(dropEv);

		await viWaitFor(() => reorder.mock.calls.length > 0);
		expect(reorder.mock.calls[0]![0]).toBe(a.id);
		expect(reorder.mock.calls[0]![1]).toMatchObject({ beforeId: b.id });
	});

	it('touch long-press then pointer move reorders local files', async () => {
		const a = await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		const b = await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'b' });
		const base = createLocalExplorerDriver(vfs);
		const reorder = vi.fn(async (id: string, opts: { beforeId?: string | null; afterId?: string | null }) => {
			await base.reorder!(id, opts);
		});
		const driver: ExplorerDriver = {
			id: base.id,
			capabilities: base.capabilities,
			ready: (...args) => base.ready(...args),
			list: (...args) => base.list(...args),
			getPath: (...args) => base.getPath(...args),
			mkdir: base.mkdir?.bind(base),
			rename: base.rename?.bind(base),
			move: base.move?.bind(base),
			copy: base.copy?.bind(base),
			delete: (...args) => base.delete(...args),
			restore: base.restore?.bind(base),
			permanentDelete: base.permanentDelete?.bind(base),
			emptyTrash: base.emptyTrash?.bind(base),
			reorder
		};
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 2);
		await viWaitFor(() => {
			const list = document.querySelector('[data-testid="fe-list"]');
			return list?.getAttribute('aria-busy') !== 'true';
		});

		const rows = Array.from(document.querySelectorAll('[data-testid="fe-file-row"]')) as HTMLElement[];
		const src = rows.find((r) => r.getAttribute('data-name') === 'b.txt')!;
		const tgt = rows.find((r) => r.getAttribute('data-name') === 'a.txt')!;
		vi.spyOn(tgt, 'getBoundingClientRect').mockReturnValue({
			top: 100,
			height: 40,
			bottom: 140,
			left: 0,
			right: 100,
			width: 100,
			x: 0,
			y: 100,
			toJSON: () => ({})
		} as DOMRect);
		Object.defineProperty(document, 'elementFromPoint', {
			configurable: true,
			writable: true,
			value: () => tgt
		});
		Object.defineProperty(document, 'elementsFromPoint', {
			configurable: true,
			writable: true,
			value: () => [tgt]
		});

		src.dispatchEvent(fakePointer('pointerdown', { pointerId: 7, clientX: 20, clientY: 20 }));
		await new Promise((r) => setTimeout(r, 280));

		document.dispatchEvent(
			fakePointer('pointermove', { pointerId: 7, clientX: 20, clientY: 105 })
		);
		document.dispatchEvent(
			fakePointer('pointerup', { pointerId: 7, clientX: 20, clientY: 105 })
		);

		await viWaitFor(() => reorder.mock.calls.length > 0);
		expect(reorder.mock.calls[0]![0]).toBe(b.id);
		expect(reorder.mock.calls[0]![1]).toMatchObject({ afterId: a.id });
	});

	it('remote driver (no sibling order) still marks rows draggable when supportsMove', async () => {
		const remote: ExplorerDriver = {
			id: 'b2',
			capabilities: {
				supportsTrash: false,
				supportsSoftDelete: false,
				supportsRename: true,
				supportsMove: true,
				supportsCopy: true,
				supportsMkdir: true,
				supportsUpload: true,
				supportsDownload: true,
				supportsSiblingOrder: false
			},
			async ready() {},
			async list() {
				return {
					entries: [
						{
							id: 'folder/',
							parentId: null,
							name: 'docs',
							kind: 'folder'
						},
						{
							id: 'f.txt',
							parentId: null,
							name: 'f.txt',
							kind: 'file'
						}
					],
					truncated: false
				};
			},
			async getPath() {
				return [];
			},
			async delete() {},
			async move() {}
		};
		render(FileExplorer, { props: { mode: 'manage', driver: remote, variant: 'panel' } });
		const root = await screen.findByTestId('file-explorer');
		expect(root.getAttribute('data-fe-backend')).toBe('b2');
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 1);
		const file = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		expect(file.getAttribute('draggable')).toBe('true');
		// no reorder lines until a drag target is set — none present initially
		expect(document.querySelector('[data-testid="fe-dnd-line-before"]')).toBeNull();
	});

	it('view-only mode disables drag', async () => {
		await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		const driver = createLocalExplorerDriver(vfs);
		render(FileExplorer, { props: { mode: 'browse', driver, variant: 'panel' } });
		await viWaitFor(() => document.querySelectorAll('[data-testid="fe-file-row"]').length >= 1);
		const row = document.querySelector('[data-testid="fe-file-row"]') as HTMLElement;
		expect(row.getAttribute('draggable')).toBe('false');
	});

	it('onContextChange exports parentId + selectedIds for copy-across', async () => {
		await vfs.writeFile({ parentId: null, name: 'sel.txt', body: 'x' });
		const driver = createLocalExplorerDriver(vfs);
		const onContextChange = vi.fn();
		render(FileExplorer, {
			props: { mode: 'manage', driver, variant: 'panel', onContextChange }
		});
		await viWaitFor(() => onContextChange.mock.calls.length > 0);
		const last = onContextChange.mock.calls.at(-1)![0];
		expect(last).toMatchObject({ parentId: null, backend: 'local' });
		expect(Array.isArray(last.selectedIds)).toBe(true);
		expect(Array.isArray(last.entries)).toBe(true);
	});
});

function fakePointer(
	type: string,
	init: { pointerId: number; clientX: number; clientY: number }
): Event {
	const e = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: init.clientX,
		clientY: init.clientY,
		button: 0
	});
	Object.defineProperty(e, 'pointerId', { value: init.pointerId });
	Object.defineProperty(e, 'pointerType', { value: 'touch' });
	return e;
}

async function viWaitFor(pred: () => boolean, ms = 4000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error('viWaitFor timeout');
}
