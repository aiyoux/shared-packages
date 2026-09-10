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
		expect(screen.getByTestId('fe-tree-row').getAttribute('data-name')).toBe('readme.txt');
	});

	it('rootId scopes the tree to one folder', async () => {
		const project = await vfs.mkdir(null, 'project');
		await vfs.mkdir(project.id, 'src');
		await vfs.mkdir(null, 'elsewhere');
		const driver = createLocalExplorerDriver(vfs);
		render(FeTreeView, {
			props: {
				driver,
				activeId: project.id,
				rootId: project.id,
				rootLabel: 'project',
				onNavigate: () => {}
			}
		});
		expect(await screen.findByText('src')).toBeTruthy();
		// Siblings of the root are outside the tree entirely.
		expect(screen.queryByText('elsewhere')).toBeNull();
		expect(screen.getByTestId('fe-tree-row-root').textContent).toContain('project');
	});

	it('empty folder keeps a collapse chevron and an indented Empty hint', async () => {
		await vfs.mkdir(null, 'blank');
		const driver = createLocalExplorerDriver(vfs);
		render(FeTreeView, {
			props: { driver, activeId: null, onNavigate: () => {} }
		});
		const row = await screen.findByTestId('fe-tree-row');
		expect(row.getAttribute('data-name')).toBe('blank');
		const toggle = row.querySelector('[data-testid="fe-tree-toggle"]') as HTMLButtonElement;
		expect(toggle.classList.contains('invisible')).toBe(false);
		await fireEvent.click(toggle);
		const hint = await screen.findByTestId('fe-tree-empty');
		expect(hint.textContent).toMatch(/Empty/);
		expect(toggle.classList.contains('invisible')).toBe(false);
		await fireEvent.click(toggle);
		expect(screen.queryByTestId('fe-tree-empty')).toBeNull();
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
