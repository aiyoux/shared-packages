import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import { createVfs, resetSharedVfsForTests } from '../src/index.ts';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';

describe('FileExplorer stacked pending bar', () => {
	beforeEach(() => {
		resetSharedVfsForTests();
		localStorage.removeItem('fe:viewMode');
		localStorage.removeItem('fe:showPreview');
	});

	it('draws translucent ready + solid transferred fills', async () => {
		const vfs = createVfs({
			dbName: `fe-pending-${Date.now()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		render(FileExplorer, {
			props: {
				mode: 'manage',
				driver,
				variant: 'panel',
				pending: [
					{
						id: 'op1:stack',
						name: 'clip.wav',
						transferred: 30,
						size: 100,
						ready: 80,
						direction: 'receiving'
					}
				]
			}
		});
		const row = await screen.findByTestId('fe-pending-row');
		expect(row.getAttribute('data-pending-name')).toBe('clip.wav');
		expect(row.querySelector('.fe-pending-fill.ahead')).toBeTruthy();
		expect(row.querySelector('.fe-pending-fill.behind')).toBeTruthy();
		expect(row.querySelector('.fe-pending-pct')?.textContent).toBe('80% · 30%');
	});

	it('overlays the dest file instead of adding a second row, then goes solid at 100%', async () => {
		const vfs = createVfs({
			dbName: `fe-pending-merge-${Date.now()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		await vfs.writeFile({ parentId: null, name: 'clip.wav', body: 'xx' });
		const driver = createLocalExplorerDriver(vfs);
		const { rerender } = render(FileExplorer, {
			props: {
				mode: 'manage',
				driver,
				variant: 'panel',
				pending: [
					{
						id: 'op-copy',
						name: 'clip.wav',
						transferred: 40,
						size: 100,
						direction: 'receiving'
					}
				]
			}
		});
		const fileRow = await screen.findByTestId('fe-file-row');
		expect(fileRow.classList.contains('fe-pending')).toBe(true);
		expect(fileRow.getAttribute('data-pending-name')).toBe('clip.wav');
		expect(screen.queryByTestId('fe-pending-row')).toBeNull();
		expect(fileRow.querySelector('.fe-pending-pct')?.textContent).toBe('40%');

		await rerender({
			mode: 'manage',
			driver,
			variant: 'panel',
			pending: [
				{
					id: 'op-copy',
					name: 'clip.wav',
					transferred: 100,
					size: 100,
					direction: 'receiving'
				}
			]
		});
		const solid = await screen.findByTestId('fe-file-row');
		expect(solid.classList.contains('fe-pending')).toBe(false);
		expect(screen.queryByTestId('fe-pending-row')).toBeNull();
		expect(solid.querySelector('.fe-pending-pct')).toBeNull();
	});

	it('keeps a 100% placeholder until the dest lists the file', async () => {
		const vfs = createVfs({
			dbName: `fe-pending-writing-${Date.now()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		render(FileExplorer, {
			props: {
				mode: 'manage',
				driver,
				variant: 'panel',
				pending: [
					{
						id: 'op-write',
						name: 'new.bin',
						transferred: 100,
						size: 100,
						direction: 'receiving'
					}
				]
			}
		});
		const row = await screen.findByTestId('fe-pending-row');
		expect(row.querySelector('.fe-pending-pct')?.textContent).toBe('100%');
	});

	it('icon view keeps the pending bar a thin strip on the thumbnail', async () => {
		localStorage.setItem('fe:viewMode', 'icons');
		const vfs = createVfs({
			dbName: `fe-pending-icons-${Date.now()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		render(FileExplorer, {
			props: {
				mode: 'manage',
				driver,
				variant: 'panel',
				pending: [
					{
						id: 'op-icon',
						name: 'shot.png',
						transferred: 40,
						size: 100,
						direction: 'receiving'
					}
				]
			}
		});
		const row = await screen.findByTestId('fe-pending-row');
		expect(row.classList.contains('fe-row-icon')).toBe(true);
		const thumb = row.querySelector('.fe-row-icon-thumb');
		const bar = screen.getByTestId('fe-pending-bar');
		expect(thumb).toBeTruthy();
		expect(thumb?.contains(bar)).toBe(true);
		expect(bar.classList.contains('on-icon')).toBe(true);
		const cs = getComputedStyle(bar);
		expect(cs.position).toBe('absolute');
		expect(cs.maxHeight).toBe('4px');
		expect(cs.height).toBe('4px');
	});
});
