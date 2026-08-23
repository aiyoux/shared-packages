/**
 * FeTreeView standalone reuse (Projects / Monitor).
 * Run: npm run test:component -w @shared-packages/file-system
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import FeTreeView from '../src/ui/FeTreeView.svelte';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';
import { createVfs, resetSharedVfsForTests, type VfsService } from '../src/index.ts';

describe('FeTreeView', () => {
	let vfs: VfsService;

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({
			dbName: `fe-tree-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	it('lists folders only by default and labels the root', async () => {
		const folder = await vfs.mkdir(null, 'docs');
		await vfs.writeFile({ parentId: folder.id, name: 'notes.txt', body: 'hi' });
		await vfs.writeFile({ parentId: null, name: 'readme.txt', body: 'x' });
		const driver = createLocalExplorerDriver(vfs);
		render(FeTreeView, {
			props: { driver, activeId: null, onNavigate: () => {} }
		});
		expect(await screen.findByText('docs')).toBeTruthy();
		expect(screen.getByTestId('fe-tree-row-root').textContent).toContain('Root');
		expect(screen.queryByText('readme.txt')).toBeNull();
	});

	it('includeFiles shows files and rootLabel overrides Root', async () => {
		await vfs.writeFile({ parentId: null, name: 'readme.txt', body: 'x' });
		const driver = createLocalExplorerDriver(vfs);
		render(FeTreeView, {
			props: {
				driver,
				activeId: null,
				onNavigate: () => {},
				includeFiles: true,
				rootLabel: 'Project'
			}
		});
		expect(await screen.findByText('readme.txt')).toBeTruthy();
		expect(screen.getByTestId('fe-tree-row-root').textContent).toContain('Project');
		expect(screen.getByTestId('fe-tree-row').getAttribute('data-kind')).toBe('file');
	});

	it('file click calls onSelect, not onNavigate', async () => {
		await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'x' });
		const driver = createLocalExplorerDriver(vfs);
		const navigated: string[] = [];
		const selected: string[] = [];
		render(FeTreeView, {
			props: {
				driver,
				activeId: null,
				includeFiles: true,
				onNavigate: (id) => {
					if (id) navigated.push(id);
				},
				onSelect: (e) => selected.push(e.name)
			}
		});
		const row = await screen.findByText('a.txt');
		await fireEvent.click(row);
		expect(selected).toEqual(['a.txt']);
		expect(navigated).toEqual([]);
	});
});
