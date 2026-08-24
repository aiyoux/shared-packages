import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectProject, findProjectRoot } from '../src/ui/detectProject.ts';
import type { ExplorerDriver, ExplorerEntry, ExplorerEntryId } from '../src/ui/explorerDriver.ts';

function driverWith(entries: Array<Pick<ExplorerEntry, 'name' | 'kind'>>): ExplorerDriver {
	return {
		id: 'memory',
		capabilities: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: false,
			supportsMove: false,
			supportsCopy: false,
			supportsMkdir: false,
			supportsUpload: false,
			supportsDownload: false,
			supportsSiblingOrder: false
		},
		async ready() {},
		async list() {
			return {
				entries: entries.map((e, i) => ({
					id: `id-${i}`,
					parentId: 'folder',
					name: e.name,
					kind: e.kind
				})),
				truncated: false
			};
		},
		async getPath() {
			return [];
		},
		async delete() {}
	};
}

type TreeNode = {
	id: string;
	parentId: string | null;
	name: string;
	kind: 'folder' | 'file';
	children: TreeNode[];
};

function treeDriver(rootChildren: TreeNode[]): ExplorerDriver {
	const byParent = new Map<string, TreeNode[]>();
	const byId = new Map<string, TreeNode>();
	const index = (nodes: TreeNode[]) => {
		for (const n of nodes) {
			byId.set(n.id, n);
			const key = n.parentId ?? '';
			const list = byParent.get(key) ?? [];
			list.push(n);
			byParent.set(key, list);
			index(n.children);
		}
	};
	index(rootChildren);

	return {
		id: 'disk',
		capabilities: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: false,
			supportsMove: false,
			supportsCopy: false,
			supportsMkdir: false,
			supportsUpload: false,
			supportsDownload: false,
			supportsSiblingOrder: false
		},
		async ready() {},
		async list(opts) {
			const key = opts.parentId ?? '';
			const kids = byParent.get(key) ?? [];
			return {
				entries: kids.map((n) => ({
					id: n.id,
					parentId: n.parentId,
					name: n.name,
					kind: n.kind
				})),
				truncated: false
			};
		},
		async getPath(id: ExplorerEntryId) {
			const chain: ExplorerEntry[] = [];
			let cur = byId.get(id);
			const guard = new Set<string>();
			while (cur) {
				if (guard.has(cur.id)) break;
				guard.add(cur.id);
				chain.unshift({
					id: cur.id,
					parentId: cur.parentId,
					name: cur.name,
					kind: cur.kind
				});
				if (!cur.parentId) break;
				cur = byId.get(cur.parentId);
			}
			return chain;
		},
		async delete() {}
	};
}

describe('detectProject', () => {
	it('is true when a child is named .git (folder)', async () => {
		const ok = await detectProject(
			driverWith([
				{ name: 'src', kind: 'folder' },
				{ name: '.git', kind: 'folder' }
			]),
			'folder'
		);
		assert.equal(ok, true);
	});

	it('is true when a child is named .git (file)', async () => {
		const ok = await detectProject(driverWith([{ name: '.git', kind: 'file' }]), 'folder');
		assert.equal(ok, true);
	});

	it('is false when there is no .git child', async () => {
		const ok = await detectProject(
			driverWith([
				{ name: 'src', kind: 'folder' },
				{ name: 'README.md', kind: 'file' }
			]),
			'folder'
		);
		assert.equal(ok, false);
	});

	it('is true for a nested folder when an ancestor has .git', async () => {
		const git: TreeNode = {
			id: 'git',
			parentId: 'proj',
			name: '.git',
			kind: 'folder',
			children: []
		};
		const src: TreeNode = {
			id: 'src',
			parentId: 'proj',
			name: 'src',
			kind: 'folder',
			children: [
				{
					id: 'main',
					parentId: 'src',
					name: 'main.ts',
					kind: 'file',
					children: []
				}
			]
		};
		const proj: TreeNode = {
			id: 'proj',
			parentId: null,
			name: 'proj',
			kind: 'folder',
			children: [git, src]
		};
		const driver = treeDriver([proj]);
		assert.equal(await detectProject(driver, 'src'), true);
		assert.deepEqual(await findProjectRoot(driver, 'src'), { found: true, id: 'proj' });
		assert.deepEqual(await findProjectRoot(driver, 'proj'), { found: true, id: 'proj' });
	});

	it('is false for a nested folder with no .git on any ancestor', async () => {
		const src: TreeNode = {
			id: 'src',
			parentId: 'proj',
			name: 'src',
			kind: 'folder',
			children: []
		};
		const proj: TreeNode = {
			id: 'proj',
			parentId: null,
			name: 'proj',
			kind: 'folder',
			children: [src]
		};
		const driver = treeDriver([proj]);
		assert.equal(await detectProject(driver, 'src'), false);
		assert.deepEqual(await findProjectRoot(driver, 'src'), { found: false, id: null });
	});

	it('falls back to children-only when getPath cannot walk parents', async () => {
		const nestedHasNoGit = driverWith([{ name: 'main.ts', kind: 'file' }]);
		assert.equal(await detectProject(nestedHasNoGit, 'src'), false);
		const nestedHasGit = driverWith([{ name: '.git', kind: 'folder' }]);
		assert.equal(await detectProject(nestedHasGit, 'src'), true);
		assert.deepEqual(await findProjectRoot(nestedHasGit, 'src'), { found: true, id: 'src' });
	});

	it('nested folder with .git only at explorer root: detectProject true, findProjectRoot id null', async () => {
		const git: TreeNode = {
			id: 'git',
			parentId: null,
			name: '.git',
			kind: 'folder',
			children: []
		};
		const src: TreeNode = {
			id: 'src',
			parentId: null,
			name: 'src',
			kind: 'folder',
			children: [
				{
					id: 'main',
					parentId: 'src',
					name: 'main.ts',
					kind: 'file',
					children: []
				}
			]
		};
		const driver = treeDriver([git, src]);
		assert.equal(await detectProject(driver, 'src'), true);
		assert.deepEqual(await findProjectRoot(driver, 'src'), { found: true, id: null });
		assert.deepEqual(await findProjectRoot(driver, null), { found: true, id: null });
	});
});
