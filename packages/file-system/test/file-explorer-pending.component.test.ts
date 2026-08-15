import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import FileExplorer from '../src/ui/FileExplorer.svelte';
import { createVfs, resetSharedVfsForTests } from '../src/index.ts';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';

describe('FileExplorer stacked pending bar', () => {
	beforeEach(() => {
		resetSharedVfsForTests();
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
		await screen.findByTestId('fe-pending-list');
		const row = screen.getByTestId('fe-pending-row');
		expect(row.getAttribute('data-pending-name')).toBe('clip.wav');
		expect(row.querySelector('.fe-pending-fill.ahead')).toBeTruthy();
		expect(row.querySelector('.fe-pending-fill.behind')).toBeTruthy();
	});
});
