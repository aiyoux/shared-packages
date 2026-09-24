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

	it('childless folder hides its chevron; a folder with subfolders keeps it', async () => {
		await vfs.mkdir(null, 'blank');
		const parent = await vfs.mkdir(null, 'parent');
		await vfs.mkdir(parent.id, 'child');
		const driver = createLocalExplorerDriver(vfs);
		render(FeTreeView, {
			props: { driver, activeId: null, onNavigate: () => {} }
		});
		await viWaitFor(() =>
			Boolean(document.querySelector('[data-testid="fe-tree-row"][data-name="blank"]'))
		);
		const blankRow = document.querySelector(
			'[data-testid="fe-tree-row"][data-name="blank"]'
		) as HTMLElement;
		// The probe listing lands asynchronously; once known empty, the
		// chevron hides and no Empty hint ever renders.
		await viWaitFor(() => {
			const toggle = blankRow.querySelector(
				'[data-testid="fe-tree-toggle"]'
			) as HTMLButtonElement | null;
			return !!toggle && toggle.classList.contains('invisible');
		});
		expect(screen.queryByTestId('fe-tree-empty')).toBeNull();
		const parentRow = document.querySelector(
			'[data-testid="fe-tree-row"][data-name="parent"]'
		) as HTMLElement;
		const parentToggle = parentRow.querySelector(
			'[data-testid="fe-tree-toggle"]'
		) as HTMLButtonElement;
		expect(parentToggle.classList.contains('invisible')).toBe(false);
		await fireEvent.click(parentToggle);
		expect(await screen.findByText('child')).toBeTruthy();
	});

	it('marks git, project, and combined folders in the tree', async () => {
		const git = await vfs.mkdir(null, 'repo');
		await vfs.mkdir(git.id, '.git');
		const proj = await vfs.mkdir(null, 'studio');
		await vfs.writeFile({
			parentId: proj.id,
			name: '.project.json',
			body: JSON.stringify({ schemaVersion: 1, name: 'studio' }),
			contentType: 'application/json'
		});
		const both = await vfs.mkdir(null, 'full');
		await vfs.mkdir(both.id, '.git');
		await vfs.writeFile({
			parentId: both.id,
			name: '.project.json',
			body: JSON.stringify({ schemaVersion: 1, name: 'full' }),
			contentType: 'application/json'
		});
		await vfs.mkdir(null, 'plain');
		const driver = createLocalExplorerDriver(vfs);
		render(FeTreeView, { props: { driver, activeId: null, onNavigate: () => {} } });
		await viWaitFor(
			() =>
				document.querySelector('[data-testid="fe-tree-row"][data-name="repo"]')?.getAttribute(
					'data-fe-folder-mark'
				) === 'git'
		);
		expect(
			document.querySelector('[data-testid="fe-tree-row"][data-name="studio"]')?.getAttribute(
				'data-fe-folder-mark'
			)
		).toBe('project');
		expect(
			document.querySelector('[data-testid="fe-tree-row"][data-name="full"]')?.getAttribute(
				'data-fe-folder-mark'
			)
		).toBe('project-git');
		expect(
			document.querySelector('[data-testid="fe-tree-row"][data-name="plain"]')?.getAttribute(
				'data-fe-folder-mark'
			)
		).toBe('plain');
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

async function viWaitFor(pred: () => boolean | Promise<boolean>, ms = 4000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (await pred()) return;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error('viWaitFor timeout');
}
