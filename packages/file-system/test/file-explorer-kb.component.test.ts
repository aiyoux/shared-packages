import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { persistKv } from '@shared-packages/ui';
import { KB_FORMAT } from '@shared-packages/doc-model';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import FeFloatingPreview from '../src/ui/FeFloatingPreview.svelte';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';
import { installLockPolyfill } from './live-locks-harness.ts';

installLockPolyfill();

const entry: ExplorerEntry = { id: 'page', kind: 'file', name: 'notes.KB', parentId: null, generation: 1 };
const content = (text: string) => [{ type: 'text', text, marks: [] }];
const page = {
	format: KB_FORMAT, id: 'page', title: 'Project notes',
	blocks: [
		{ id: 'p', type: 'paragraph', content: content('A readable paragraph') },
		{ id: 'callout', type: 'callout', variant: 'info', children: [
			{ id: 'heading', type: 'heading', level: 2, content: content('Nested heading') },
			{ id: 'code', type: 'code', language: 'js', text: 'console.log("hello")' }
		] },
		{ id: 'toggle', type: 'toggle', open: false, children: [
			{ id: 'list', type: 'list_item', ordered: false, content: content('Nested list item') }
		] },
		{ id: 'table', type: 'table', children: [{ id: 'row', type: 'table_row', children: [
			{ id: 'cell1', type: 'table_cell', content: content('Column A') },
			{ id: 'cell2', type: 'table_cell', content: content('Column B') }
		] }] }
	]
};

const blob = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' });
function fixture(bytes = blob(page)): ExplorerDriver {
	return {
		id: 'memory',
		capabilities: { supportsTrash: false, supportsSoftDelete: false, supportsRename: false,
			supportsMove: false, supportsCopy: false, supportsMkdir: false, supportsUpload: false,
			supportsDownload: true, supportsSiblingOrder: false },
		ready: async () => {}, list: async () => ({ entries: [entry], truncated: false }),
		getPath: async () => [], delete: async () => {}, readBlob: vi.fn(async () => bytes)
	};
}

beforeEach(() => {
	for (const key of ['fe:previewDock', 'fe:showPreview', 'fe:viewMode', 'fe:showHidden']) persistKv.removeItem(key);
	Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
});

describe('Knowledge Base file preview', () => {
	it.each(['dock', 'popup'] as const)('shows title and nested page contents in the %s', async (variant) => {
		const driver = fixture();
		render(FeFloatingPreview, { props: { entry, driver, variant, onClose: () => {} } });
		const preview = await screen.findByTestId(variant === 'dock' ? 'fe-preview-text' : 'fe-float-text');
		await waitFor(() => expect(preview.querySelector('h2')?.textContent).toBe('Project notes'));
		const body = preview.querySelector('pre')!.textContent!;
		for (const text of ['A readable paragraph', 'Nested heading', 'console.log("hello")', 'Nested list item', 'Column A\tColumn B']) expect(body).toContain(text);
		expect(body).not.toContain('"format"');
		expect(preview.getAttribute('data-format')).toBe('kb');
		expect(driver.readBlob).toHaveBeenCalledTimes(1);
	});

	it('downloads a complete remote KB document on demand instead of parsing a partial byte range', async () => {
		const driver = { ...fixture(), id: 'monitor', readBlob: undefined,
			download: vi.fn(async () => blob(page)), rangeUrl: vi.fn(), thumbUrl: vi.fn() };
		const props = { entry, driver, variant: 'dock' as const, loadMedia: false, onClose: () => {} };
		const view = render(FeFloatingPreview, { props });
		expect(screen.getByTestId('fe-show-preview')).toBeTruthy();
		expect(driver.download).not.toHaveBeenCalled();
		await view.rerender({ ...props, loadMedia: true });
		await waitFor(() => expect(screen.getByText('Project notes')).toBeTruthy());
		expect(driver.download).toHaveBeenCalledWith(entry.id);
		expect(driver.rangeUrl).not.toHaveBeenCalled();
		expect(driver.thumbUrl).not.toHaveBeenCalled();
	});

	it('truncates a long docked body while keeping the title and escapes document text', async () => {
		const text = '<script>alert(1)</script>' + 'x'.repeat(5000);
		const driver = fixture(blob({ ...page, title: '<b>Title</b>', blocks: [{ id: 'p', type: 'paragraph', content: content(text) }] }));
		render(FeFloatingPreview, { props: { entry, driver, variant: 'dock', onClose: () => {} } });
		const preview = await screen.findByTestId('fe-preview-text');
		await waitFor(() => expect(preview.querySelector('pre')?.textContent).toBe(text.slice(0, 4000)));
		expect(preview.querySelector('h2')!.textContent).toBe('<b>Title</b>');
		expect(preview.querySelector('script, b')).toBeNull();
		expect(preview.getAttribute('data-truncated')).toBe('true');
	});

	it.each(['', '{"format":"kb","blocks":', '{"format":"other"}'])('handles empty or invalid KB bytes: %j', async (raw) => {
		render(FeFloatingPreview, { props: { entry, driver: fixture(new Blob([raw])), variant: 'dock', onClose: () => {} } });
		const preview = await screen.findByTestId('fe-preview-text');
		await waitFor(() => expect(preview.textContent).not.toContain('Loading'));
		if (!raw) expect(preview.textContent).toContain('Empty file');
		else expect(preview.querySelector('.error')).not.toBeNull();
	});

	it('updates the docked page after the same file is edited', async () => {
		const readBlob = vi.fn().mockResolvedValueOnce(blob(page)).mockResolvedValueOnce(blob({ ...page, title: 'Edited notes' }));
		const props = { entry, driver: { ...fixture(), readBlob }, variant: 'dock' as const, onClose: () => {} };
		const view = render(FeFloatingPreview, { props });
		await screen.findByText('Project notes');
		await view.rerender({ ...props, entry: { ...entry, generation: 2 } });
		await screen.findByText('Edited notes');
		expect(readBlob).toHaveBeenCalledTimes(2);
	});

	it('opens a KB file with Space without reading its body for listing thumbnails', async () => {
		persistKv.setItem('fe:showPreview', 'true');
		const driver = fixture();
		render(FileExplorer, { props: { driver, mode: 'manage' } });
		await waitFor(() => expect(document.querySelector('[data-testid="fe-file-row"][data-name="notes.KB"]')).not.toBeNull());
		const row = document.querySelector('[data-testid="fe-file-row"][data-name="notes.KB"]')!;
		await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
		expect(driver.readBlob).not.toHaveBeenCalled();
		await fireEvent.click(row);
		await fireEvent.keyDown(row, { key: ' ', code: 'Space' });
		await screen.findByText('Project notes');
		expect(screen.getByTestId('fe-float-text').getAttribute('data-format')).toBe('kb');
	});
});
