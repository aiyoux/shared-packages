import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs } from '../src/index.ts';
import {
	exportProjectAsBundle,
	exportProjectAsFiles,
	importProject
} from '../src/projectExport.ts';

/**
 * A `.sprj` bundle records the node id each file had at export, so an import
 * can repoint the `vfs:<nodeId>` references documents carry in their bodies.
 * Without it every internal link in the archive is dead on arrival: import
 * mints fresh ids and nothing rewrites the bodies.
 *
 * The rewrite itself belongs to the caller — only it knows the formats — so
 * what is verified here is that the map handed over is correct and complete.
 */
describe('project export carries node ids for reference rebuilding', () => {
	async function projectWithTwoFiles() {
		const vfs = createVfs({ name: `refs-${crypto.randomUUID()}` });
		await vfs.ready();
		const root = await vfs.mkdir(null, 'Project A');
		const page = await vfs.writeFile({
			parentId: root.id,
			name: 'page.skch',
			body: new TextEncoder().encode('{"format":"skch"}')
		});
		const anim = await vfs.writeFile({
			parentId: root.id,
			name: 'walk.anim',
			body: new TextEncoder().encode('{"schemaVersion":1}')
		});
		return { vfs, root, page, anim };
	}

	it('round-trips a bundle with an id map covering every file', async () => {
		const { vfs, root, page, anim } = await projectWithTwoFiles();

		const bundle = await exportProjectAsBundle(vfs, root.id);
		const result = await importProject(vfs, null, bundle.bytes, { name: 'Project A 2' });

		assert.equal(result.refsRebuildable, true);
		assert.equal(result.idMap.size, 2);

		// Every old id maps to a real, different node in the imported tree.
		for (const oldId of [page.id, anim.id]) {
			const newId = result.idMap.get(oldId);
			assert.ok(newId, `no mapping for ${oldId}`);
			assert.notEqual(newId, oldId);
			const node = await vfs.get(newId!);
			assert.ok(node, 'mapped id names a real node');
		}
	});

	it('maps the id onto the file that actually holds those bytes', async () => {
		const { vfs, root, page, anim } = await projectWithTwoFiles();

		const bundle = await exportProjectAsBundle(vfs, root.id);
		const result = await importProject(vfs, null, bundle.bytes, { name: 'Project A 3' });

		// An off-by-one in the manifest pairing would repoint every reference at
		// the wrong sibling, which is worse than not repointing at all.
		const pageCopy = await vfs.get(result.idMap.get(page.id)!);
		const animCopy = await vfs.get(result.idMap.get(anim.id)!);
		assert.equal(pageCopy?.name, 'page.skch');
		assert.equal(animCopy?.name, 'walk.anim');
	});

	it('says plainly that a files-mode zip cannot rebuild references', async () => {
		const { vfs, root } = await projectWithTwoFiles();

		const zip = await exportProjectAsFiles(vfs, root.id);
		const result = await importProject(vfs, null, zip.bytes, { name: 'Project A 4' });

		// A plain tree has nowhere to have recorded the ids. Saying so is the
		// point — silently importing broken links is the failure being avoided.
		assert.equal(result.refsRebuildable, false);
		assert.equal(result.idMap.size, 0);
	});
});
