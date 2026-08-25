import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests, VfsError } from '../src/index.ts';
import { diffDocumentSnapshots } from '../src/documentSession.ts';
import type { DocumentSnapshot } from '../src/types.ts';
import type { DocumentEvent } from '../src/types.ts';

function wait(ms = 20): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe('document session', () => {
	let vfs: ReturnType<typeof createVfs>;

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({
			dbName: `doc-sess-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	it('diffDocumentSnapshots emits path then content when both change', () => {
		const prev: DocumentSnapshot = {
			node: {
				id: 'f',
				parentId: 'a',
				name: 'x.skch',
				kind: 'file',
				createdAt: 1,
				updatedAt: 1,
				generation: 1
			},
			path: []
		};
		const next: DocumentSnapshot = {
			node: {
				id: 'f',
				parentId: 'b',
				name: 'y.skch',
				kind: 'file',
				createdAt: 1,
				updatedAt: 2,
				generation: 2
			},
			path: []
		};
		const events = diffDocumentSnapshots(prev, next);
		assert.equal(events[0]?.type, 'path');
		assert.equal(events[1]?.type, 'content');
	});

	it('rename emits path only; dirty save with original gen succeeds', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'a.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const doc = await vfs.openDocument(f.id);
		const events: DocumentEvent[] = [];
		doc.subscribe((e) => events.push(e));
		doc.markDirty();
		await vfs.rename(f.id, 'b');
		await wait();
		assert.ok(events.some((e) => e.type === 'path'));
		assert.equal(
			events.some((e) => e.type === 'content'),
			false
		);
		assert.equal(doc.generation, f.generation);
		const saved = await doc.save({ v: 2 });
		assert.equal(saved.generation, f.generation + 1);
		assert.equal((await vfs.get(f.id))!.name, 'b.skch');
		doc.close();
	});

	it('external content write on a dirty session conflicts and does not adopt gen', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'c.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const doc = await vfs.openDocument(f.id);
		const events: DocumentEvent[] = [];
		doc.subscribe((e) => events.push(e));
		doc.markDirty();
		await vfs.updateFile(f.id, { v: 9 }, { expectedGeneration: f.generation });
		await wait(40);
		const content = events.find((e) => e.type === 'content');
		assert.ok(content && content.type === 'content' && content.conflict);
		assert.equal(doc.generation, f.generation);
		await assert.rejects(
			() => doc.save({ v: 2 }),
			(e: unknown) => e instanceof VfsError && e.code === 'GENERATION_CONFLICT'
		);
		assert.equal(doc.generation, f.generation);
		doc.close();
	});

	it('saveAs mints a new id; original remains bound', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'd.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const doc = await vfs.openDocument(f.id);
		const copy = await doc.saveAs({
			parentId: null,
			name: 'd-copy.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		assert.notEqual(copy.id, f.id);
		assert.equal(doc.id, f.id);
		assert.equal(doc.bound, true);
		doc.close();
	});

	it('trash unbinds; save throws; saveAs still works', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'e.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const doc = await vfs.openDocument(f.id);
		const events: DocumentEvent[] = [];
		doc.subscribe((e) => events.push(e));
		await vfs.trash(f.id);
		await wait();
		assert.ok(events.some((e) => e.type === 'deleted'));
		assert.equal(doc.bound, false);
		await assert.rejects(
			() => doc.save({ v: 2 }),
			(e: unknown) => e instanceof VfsError && e.code === 'TRASH_STATE'
		);
		const recovered = await doc.saveAs({
			parentId: null,
			name: 'e-recovered.skch',
			fileType: 'skch',
			body: { v: 2 }
		});
		assert.notEqual(recovered.id, f.id);
		doc.close();
	});

	it('ancestor rename emits path without changing file generation', async () => {
		const folder = await vfs.mkdir(null, 'Old');
		const f = await vfs.writeFile({
			parentId: folder.id,
			name: 'g.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const doc = await vfs.openDocument(f.id);
		const events: DocumentEvent[] = [];
		doc.subscribe((e) => events.push(e));
		await vfs.rename(folder.id, 'New');
		await wait();
		assert.ok(events.some((e) => e.type === 'path'));
		assert.equal(doc.generation, f.generation);
		assert.ok(doc.path.some((n) => n.name === 'New'));
		doc.close();
	});

	it('save({ force: true }) overwrites after a content conflict', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'force.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const doc = await vfs.openDocument(f.id);
		doc.markDirty();
		await vfs.updateFile(f.id, { v: 9 }, { expectedGeneration: f.generation });
		await wait(40);
		const saved = await doc.save({ v: 2 }, { force: true });
		assert.deepEqual(await vfs.readJson(f.id), { v: 2 });
		assert.ok(saved.generation > f.generation);
		doc.close();
	});

	it('openDocument rejects missing, folder, and trashed ids', async () => {
		const folder = await vfs.mkdir(null, 'F');
		await assert.rejects(
			() => vfs.openDocument('nope'),
			(e: unknown) => e instanceof VfsError && e.code === 'NOT_FOUND'
		);
		await assert.rejects(
			() => vfs.openDocument(folder.id),
			(e: unknown) => e instanceof VfsError && e.code === 'NOT_A_FILE'
		);
		const f = await vfs.writeFile({
			parentId: null,
			name: 't.skch',
			fileType: 'skch',
			body: {}
		});
		await vfs.trash(f.id);
		await assert.rejects(
			() => vfs.openDocument(f.id),
			(e: unknown) => e instanceof VfsError && e.code === 'TRASH_STATE'
		);
	});
});
