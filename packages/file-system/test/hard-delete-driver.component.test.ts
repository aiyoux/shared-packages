/**
 * Hard-delete confirm + capability chrome when supportsSoftDelete is false (B2-like).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import type { ExplorerDriver, ExplorerEntry, ExplorerListResult } from '../src/ui/explorerDriver.js';

function mockHardDeleteDriver(
	entries: ExplorerEntry[],
	driverId = 'mock-b2'
): {
	driver: ExplorerDriver;
	deleted: string[];
} {
	const deleted: string[] = [];
	let rows = [...entries];
	const driver: ExplorerDriver = {
		id: driverId,
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
		async list(): Promise<ExplorerListResult> {
			return { entries: rows, truncated: false };
		},
		async getPath() {
			return [];
		},
		async delete(id: string) {
			deleted.push(id);
			rows = rows.filter((r) => r.id !== id);
		},
		async mkdir() {
			throw new Error('not used');
		},
		async rename() {
			throw new Error('not used');
		},
		async move() {},
		async copy() {},
		async upload() {
			throw new Error('not used');
		},
		async download() {
			return new Blob([]);
		}
	};
	return { driver, deleted };
}

describe('FileExplorer hard-delete backend', () => {

	it('hides trash chrome; shows upload when caps allow', async () => {
		const { driver } = mockHardDeleteDriver([]);
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('file-explorer');
		expect(screen.getByTestId('file-explorer').getAttribute('data-fe-backend')).toBe('mock-b2');
		expect(screen.queryByTestId('fe-trash-view')).toBeNull();
		// "shows upload when caps allow" — this driver has upload(), so it does.
		expect(screen.getByTestId('fe-upload')).toBeTruthy();
		expect(screen.getByTestId('fe-new-folder')).toBeTruthy();
	});

	it('confirms before hard delete; cancel leaves file', async () => {
		const file: ExplorerEntry = {
			id: 'file.bin',
			parentId: null,
			name: 'file.bin',
			kind: 'file'
		};
		const { driver, deleted } = mockHardDeleteDriver([file]);
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('fe-file-row');
		await fireEvent.click(screen.getByTestId('fe-file-row'));
		await fireEvent.click(await screen.findByTestId('fe-trash-selected'));
		const dialog = await screen.findByTestId('fe-confirm-dialog');
		expect(dialog.textContent).toMatch(/file\.bin/);
		expect(dialog.textContent).not.toMatch(/remote/i);
		await fireEvent.click(screen.getByTestId('fe-confirm-cancel'));
		expect(deleted).toHaveLength(0);
		expect(screen.getByTestId('fe-file-row')).toBeTruthy();
	});

	it('confirms and deletes when user accepts', async () => {
		const file: ExplorerEntry = {
			id: 'gone.bin',
			parentId: null,
			name: 'gone.bin',
			kind: 'file'
		};
		const { driver, deleted } = mockHardDeleteDriver([file]);
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('fe-file-row');
		await fireEvent.click(screen.getByTestId('fe-file-row'));
		await fireEvent.click(await screen.findByTestId('fe-trash-selected'));
		await screen.findByTestId('fe-confirm-dialog');
		await fireEvent.click(screen.getByTestId('fe-confirm-go'));
		expect(deleted).toEqual(['gone.bin']);
		// After refresh list is empty
		await vi.waitFor(() => {
			expect(screen.queryByTestId('fe-file-row')).toBeNull();
		});
	});

	it('memory confirm does not call the files remote', async () => {
		const file: ExplorerEntry = {
			id: 'clip.wav',
			parentId: null,
			name: 'clip.wav',
			kind: 'file'
		};
		const { driver } = mockHardDeleteDriver([file], 'memory');
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('fe-file-row');
		await fireEvent.click(screen.getByTestId('fe-file-row'));
		await fireEvent.click(await screen.findByTestId('fe-trash-selected'));
		const dialog = await screen.findByTestId('fe-confirm-dialog');
		expect(dialog.textContent).toMatch(/clip\.wav/);
		expect(dialog.textContent).toMatch(/no trash/);
		expect(dialog.textContent).not.toMatch(/remote/i);
		await fireEvent.click(screen.getByTestId('fe-confirm-cancel'));
		expect(screen.queryByTestId('fe-confirm-dialog')).toBeNull();
	});
});
