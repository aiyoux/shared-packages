import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectProject } from '../src/ui/detectProject.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

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
});
