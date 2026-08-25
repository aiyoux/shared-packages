/**
 * FeArchiveDialog path copy: shuttle (B2/rclone) vs host (monitor).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import FeArchiveDialog from '../src/ui/FeArchiveDialog.svelte';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

const entry: ExplorerEntry = {
	id: 'note.txt',
	parentId: null,
	name: 'note.txt',
	kind: 'file'
};

function stubDriver(partial: Partial<ExplorerDriver> & Pick<ExplorerDriver, 'id'>): ExplorerDriver {
	return {
		capabilities: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: false,
			supportsMove: false,
			supportsCopy: false,
			supportsMkdir: false,
			supportsUpload: true,
			supportsDownload: true,
			supportsSiblingOrder: false
		},
		ready: async () => {},
		list: async () => ({ entries: [], truncated: false }),
		getPath: async () => [],
		delete: async () => {},
		upload: async () => entry,
		...partial
	};
}

describe('FeArchiveDialog path copy', () => {
	it('B2 compress states that files download, process here, then upload', () => {
		render(FeArchiveDialog, {
			props: {
				kind: 'compress',
				entries: [entry],
				driver: stubDriver({ id: 'b2' }),
				onDone: vi.fn(),
				onCancel: vi.fn()
			}
		});
		const note = screen.getByTestId('fe-archive-path-note');
		expect(note.textContent).toMatch(/downloads/i);
		expect(note.textContent).toMatch(/uploads/i);
		expect(screen.getByTestId('fe-archive-run').textContent).toMatch(/Download, compress, and upload/);
		expect(screen.queryByTestId('fe-archive-where')).toBeNull();
	});

	it('monitor compress defaults to on-computer zip with browser opt-in', async () => {
		const archive = vi.fn(async () => ({ path: '/tmp/note.zip', kind: 'file', size: 12 }));
		render(FeArchiveDialog, {
			props: {
				kind: 'compress',
				entries: [entry],
				driver: stubDriver({
					id: 'monitor',
					absolutePath: (id) => (id ? `/tmp/${id}` : '/tmp'),
					archive
				}),
				onDone: vi.fn(),
				onCancel: vi.fn()
			}
		});
		expect(screen.getByTestId('fe-archive-path-note').textContent).toMatch(/not downloaded/i);
		expect(screen.getByTestId('fe-archive-where-host')).toBeTruthy();
		expect(screen.getByTestId('fe-archive-host-format')).toBeTruthy();
		expect(screen.getByTestId('fe-archive-run').textContent).toMatch(/Zip on this computer/);
		expect(screen.getByTestId('fe-archive-dialog').getAttribute('data-where')).toBe('host');
		expect(screen.queryByTestId('fe-archive-engine')).toBeNull();

		await fireEvent.click(screen.getByTestId('fe-archive-where-browser'));
		expect(screen.getByTestId('fe-archive-path-note').textContent).toMatch(/downloads/i);
		expect(screen.getByTestId('fe-archive-engine')).toBeTruthy();
		expect(screen.getByTestId('fe-archive-run').textContent).toMatch(/Download, compress, and upload/);
	});
});
