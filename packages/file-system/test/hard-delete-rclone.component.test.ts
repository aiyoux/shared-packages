/**
 * Hard-delete confirm + capability chrome when supportsSoftDelete is false (rclone-like).
 * Mirrors hard-delete-driver.component.test.ts with id=rclone | mock-rclone.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import type { ExplorerDriver, ExplorerEntry, ExplorerListResult } from '../src/ui/explorerDriver.js';

function mockRcloneHardDeleteDriver(
	entries: ExplorerEntry[],
	driverId: 'rclone' | 'mock-rclone' = 'rclone'
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

describe('FileExplorer hard-delete rclone backend', () => {
	let confirmSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		confirmSpy = vi.spyOn(window, 'confirm');
	});

	afterEach(() => {
		confirmSpy.mockRestore();
	});

	it('hard-delete.chrome: data-fe-backend=rclone; trash hidden; upload + mkdir visible', async () => {
		const { driver } = mockRcloneHardDeleteDriver([], 'rclone');
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('file-explorer');
		expect(screen.getByTestId('file-explorer').getAttribute('data-fe-backend')).toBe('rclone');
		expect(screen.queryByTestId('fe-trash-view')).toBeNull();
		expect(screen.queryByTestId('fe-empty-trash')).toBeNull();
		expect(screen.queryByTestId('fe-restore')).toBeNull();
		expect(screen.getByTestId('fe-upload')).toBeTruthy();
		expect(screen.getByTestId('fe-new-folder')).toBeTruthy();
	});

	it('hard-delete.chrome: mock-rclone id also sets data-fe-backend', async () => {
		const { driver } = mockRcloneHardDeleteDriver([], 'mock-rclone');
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('file-explorer');
		expect(screen.getByTestId('file-explorer').getAttribute('data-fe-backend')).toBe(
			'mock-rclone'
		);
	});

	it('caps.noRestore: no restore / empty-trash chrome', async () => {
		const { driver } = mockRcloneHardDeleteDriver([]);
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('file-explorer');
		expect(screen.queryByTestId('fe-restore')).toBeNull();
		expect(screen.queryByTestId('fe-empty-trash')).toBeNull();
		expect(screen.queryByTestId('fe-permanent-delete')).toBeNull();
	});

	it('hard-delete.confirm.cancel: confirm false → delete not called', async () => {
		const file: ExplorerEntry = {
			id: 'file.bin',
			parentId: null,
			name: 'file.bin',
			kind: 'file'
		};
		const { driver, deleted } = mockRcloneHardDeleteDriver([file]);
		confirmSpy.mockReturnValue(false);
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('fe-file-row');
		await fireEvent.click(screen.getByTestId('fe-row-trash'));
		expect(confirmSpy).toHaveBeenCalled();
		expect(deleted).toHaveLength(0);
		expect(screen.getByTestId('fe-file-row')).toBeTruthy();
	});

	it('hard-delete.confirm.accept: confirm true → delete + row gone', async () => {
		const file: ExplorerEntry = {
			id: 'gone.bin',
			parentId: null,
			name: 'gone.bin',
			kind: 'file'
		};
		const { driver, deleted } = mockRcloneHardDeleteDriver([file]);
		confirmSpy.mockReturnValue(true);
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('fe-file-row');
		await fireEvent.click(screen.getByTestId('fe-row-trash'));
		expect(confirmSpy).toHaveBeenCalled();
		expect(deleted).toEqual(['gone.bin']);
		await vi.waitFor(() => {
			expect(screen.queryByTestId('fe-file-row')).toBeNull();
		});
	});

	it('hard-delete.copy: confirm message mentions permanent / remote storage', async () => {
		const file: ExplorerEntry = {
			id: 'x.bin',
			parentId: null,
			name: 'x.bin',
			kind: 'file'
		};
		const { driver } = mockRcloneHardDeleteDriver([file]);
		confirmSpy.mockReturnValue(false);
		render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
		await screen.findByTestId('fe-file-row');
		await fireEvent.click(screen.getByTestId('fe-row-trash'));
		expect(confirmSpy).toHaveBeenCalled();
		const msg = String(confirmSpy.mock.calls[0]?.[0] ?? '');
		expect(msg.toLowerCase()).toMatch(/permanent/);
		expect(msg.toLowerCase()).toMatch(/remote/);
	});

	it('hard-delete.multiSelect: confirm once then batch delete', async () => {
		const files: ExplorerEntry[] = [
			{ id: 'a.bin', parentId: null, name: 'a.bin', kind: 'file' },
			{ id: 'b.bin', parentId: null, name: 'b.bin', kind: 'file' }
		];
		const { driver, deleted } = mockRcloneHardDeleteDriver(files);
		confirmSpy.mockReturnValue(true);
		render(FileExplorer, {
			props: { mode: 'manage', driver, variant: 'panel', multiSelect: true }
		});
		const rows = await screen.findAllByTestId('fe-file-row');
		expect(rows.length).toBe(2);
		const checks = screen.getAllByTestId('fe-select');
		expect(checks.length).toBeGreaterThanOrEqual(2);
		await fireEvent.click(checks[0]!);
		await fireEvent.click(checks[1]!);
		const batch = await screen.findByTestId('fe-trash-selected');
		await fireEvent.click(batch);
		expect(confirmSpy).toHaveBeenCalledTimes(1);
		const batchMsg = String(confirmSpy.mock.calls[0]?.[0] ?? '');
		expect(batchMsg.toLowerCase()).toMatch(/permanent/);
		expect(deleted.sort()).toEqual(['a.bin', 'b.bin'].sort());
		await vi.waitFor(() => {
			expect(screen.queryAllByTestId('fe-file-row')).toHaveLength(0);
		});
	});
});
