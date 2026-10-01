/**
 * FeTreeView standalone reuse (Projects / Monitor).
 * Run: npm run test:component -w @shared-packages/file-system
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import FeTreeView from '../src/ui/FeTreeView.svelte';
import FeTreeNavHarness from './FeTreeNavHarness.svelte';
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

	it('refreshing a collapsed tree does not crawl beyond the folders on screen', async () => {
		const visible = new Set<string | null>([null]);
		for (let n = 0; n < 3; n++) {
			const top = await vfs.mkdir(null, `top-${n}`);
			visible.add(top.id);
			for (let m = 0; m < 3; m++) {
				const inner = await vfs.mkdir(top.id, `inner-${m}`);
				await vfs.mkdir(inner.id, 'deep');
			}
		}
		const local = createLocalExplorerDriver(vfs);
		const list = vi.fn(local.list.bind(local));
		let changed: (() => void) | undefined;
		const driver = {
			...local, id: 'monitor', list,
			subscribeChanges(fn: () => void) { changed = fn; return () => {}; }
		};
		render(FeTreeView, { props: { driver, activeId: null, onNavigate: () => {} } });
		await screen.findByText('top-0');
		await viWaitFor(() => list.mock.calls.some(([opts]) => opts.parentId === [...visible][1]));
		for (let n = 0; n < 5; n++) {
			changed?.();
			await new Promise((resolve) => setTimeout(resolve, 30));
		}
		const outside = list.mock.calls.filter(([opts]) => !visible.has(opts.parentId));
		expect(outside.map(([opts]) => opts.parentId)).toEqual([]);
		// One root read plus three visible-row probes, on mount and each change.
		expect(list.mock.calls.length).toBeLessThanOrEqual(24);
	});

	it('refreshes expanded rows but stops visiting their descendants after collapse', async () => {
		const top = await vfs.mkdir(null, 'top');
		const inner = await vfs.mkdir(top.id, 'inner');
		const deep = await vfs.mkdir(inner.id, 'deep');
		await vfs.mkdir(deep.id, 'hidden');
		const local = createLocalExplorerDriver(vfs);
		const list = vi.fn(local.list.bind(local));
		let changed: (() => void) | undefined;
		const driver = {
			...local, id: 'monitor', list,
			subscribeChanges(fn: () => void) { changed = fn; return () => {}; }
		};
		render(FeTreeView, { props: { driver, activeId: null, onNavigate: () => {} } });
		await screen.findByText('top');
		const toggle = document.querySelector('[data-name="top"] [data-testid="fe-tree-toggle"]')!;
		await fireEvent.click(toggle);
		await screen.findByText('inner');
		await viWaitFor(() => list.mock.calls.some(([opts]) => opts.parentId === inner.id));
		list.mockClear();
		changed?.();
		await viWaitFor(() => list.mock.calls.some(([opts]) => opts.parentId === inner.id));
		expect(list.mock.calls.some(([opts]) => opts.parentId === deep.id)).toBe(false);
		await fireEvent.click(toggle);
		expect(screen.queryByText('inner')).toBeNull();
		list.mockClear();
		changed?.();
		await viWaitFor(() => list.mock.calls.some(([opts]) => opts.parentId === top.id));
		expect(list.mock.calls.map(([opts]) => opts.parentId)).toEqual([null, top.id]);
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

	it('navigating between childless siblings closes the previous folder', async () => {
		await vfs.mkdir(null, 'alpha');
		await vfs.mkdir(null, 'beta');
		const driver = createLocalExplorerDriver(vfs);
		// The harness owns activeId like FileExplorer does: row clicks update
		// it through props on the live instance.
		render(FeTreeNavHarness, { props: { driver } });
		const row = (name: string) =>
			document.querySelector(`[data-testid="fe-tree-row"][data-name="${name}"]`) as HTMLElement | null;
		const rowOpen = (name: string) =>
			!!row(name)?.parentElement?.querySelector(':scope > .fe-tree-children');
		await viWaitFor(() => !!row('alpha') && !!row('beta'));
		// Open alpha: its row renders the open (children) container.
		await fireEvent.click(await screen.findByText('alpha'));
		await viWaitFor(() => rowOpen('alpha'));
		expect(rowOpen('beta')).toBe(false);
		// Open the sibling: alpha must close again even though neither folder
		// has children (and therefore no chevron to collapse it with).
		await fireEvent.click(await screen.findByText('beta'));
		await viWaitFor(() => rowOpen('beta'));
		expect(rowOpen('alpha')).toBe(false);
	});

	it('chevron appears when a subfolder lands and hides when the last one leaves', async () => {
		const blank = await vfs.mkdir(null, 'blank');
		const driver = createLocalExplorerDriver(vfs);
		render(FeTreeNavHarness, { props: { driver } });
		const toggle = () =>
			document.querySelector(
				'[data-testid="fe-tree-row"][data-name="blank"] [data-testid="fe-tree-toggle"]'
			) as HTMLButtonElement | null;
		// Probed childless: no chevron.
		await viWaitFor(() => !!toggle() && toggle()!.classList.contains('invisible'));
		// Another tab adds a subfolder: the chevron must appear on its own.
		const inner = await vfs.mkdir(blank.id, 'inner');
		await viWaitFor(() => !!toggle() && !toggle()!.classList.contains('invisible'));
		// Removing the last subfolder hides it again.
		await vfs.trash(inner.id);
		await viWaitFor(() => !!toggle() && toggle()!.classList.contains('invisible'));
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
