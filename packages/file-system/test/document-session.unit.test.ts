import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests, VfsError } from '../src/index.ts';
import { createOpenDocument, diffDocumentSnapshots, type DocumentHost } from '../src/documentSession.ts';
import type { DocumentSnapshot, UpdateFileOpts, VfsNode, WriteFileInput } from '../src/types.ts';
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

	it('own save on a dirty session does not emit a content conflict', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'self.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const doc = await vfs.openDocument(f.id);
		const events: DocumentEvent[] = [];
		doc.subscribe((e) => events.push(e));
		doc.markDirty();
		await doc.save({ v: 2 });
		await wait(40);
		assert.equal(
			events.some((e) => e.type === 'content' && e.conflict),
			false
		);
		assert.equal(doc.dirty, false);
		assert.deepEqual(await vfs.readJson(f.id), { v: 2 });
		doc.close();
	});

	it('own-save echo after a follow-up edit is not a generation conflict', async () => {
		const folder = await vfs.mkdir(null, 'untitled-2');
		const f = await vfs.writeFile({
			parentId: folder.id,
			name: 'index.kb',
			fileType: 'kb',
			body: { v: 1 }
		});
		const doc = await vfs.openDocument(f.id);
		const events: DocumentEvent[] = [];
		doc.subscribe((e) => events.push(e));
		doc.markDirty();
		await doc.save({ v: 2 });
		// Title rename: save lands, then a follow-up local edit (or slug sync
		// marking dirty) happens before the live snapshot of that save arrives.
		doc.markDirty();
		await vfs.rename(folder.id, 'renamed');
		await wait(40);
		assert.equal(
			events.some((e) => e.type === 'content' && e.conflict),
			false
		);
		assert.equal(doc.dirty, true);
		assert.equal(doc.generation, f.generation + 1);
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

/** Minimal DocumentHost over one node with a gateable updateFile, so a
 *  foreign commit can be injected inside the save window deterministically. */
function createGatedHost(initial: VfsNode) {
	let node: VfsNode = { ...initial };
	const listeners = new Set<() => void>();
	let gate: Promise<void> | null = null;
	let openGate: (() => void) | null = null;
	const host: DocumentHost = {
		async get() {
			return { ...node };
		},
		async getPath() {
			return [{ ...node }];
		},
		subscribe(fn: () => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		async updateFile(_id: string, _body: unknown, opts: UpdateFileOpts) {
			const expected = node.generation;
			if (!opts.force && opts.expectedGeneration !== expected) {
				throw new VfsError('GENERATION_CONFLICT', _id);
			}
			if (gate) await gate;
			// Our commit: +1 over the generation the CAS read. A foreign commit
			// after ours is simulated by the test bumping `node` past this.
			node = { ...node, generation: expected + 1, updatedAt: expected + 1 };
			return { ...node };
		},
		async writeFile(input: WriteFileInput) {
			return { ...initial, ...(input as object), id: 'copy', generation: 1 } as VfsNode;
		}
	};
	return {
		host,
		poll: () => {
			for (const fn of [...listeners]) fn();
		},
		bump: (gen: number) => {
			node = { ...node, generation: gen, updatedAt: gen };
		},
		holdGate: () => {
			gate = new Promise<void>((resolve) => {
				openGate = resolve;
			});
		},
		openGate: () => openGate
	};
}

describe('save-window foreign re-delivery', () => {
	const baseNode: VfsNode = {
		id: 'f1',
		parentId: null,
		name: 'w.skch',
		kind: 'file',
		createdAt: 1,
		updatedAt: 1,
		generation: 1
	};

	it('a foreign write inside the save window is re-delivered as a conflict once the save settles', async () => {
		const g = createGatedHost(baseNode);
		const doc = await createOpenDocument(g.host, 'f1');
		const events: DocumentEvent[] = [];
		doc.subscribe((e) => events.push(e));
		doc.markDirty();
		g.holdGate();
		const saved = doc.save({ v: 2 });
		// A foreign tab commits on top of ours while our write is still in
		// flight: gen 3, above anything our write could produce (2). The user
		// also keeps editing during the window, so the settle must surface the
		// foreign write, not adopt it.
		g.bump(3);
		g.poll();
		doc.markDirty();
		const release = g.openGate();
		release!();
		await saved;
		await wait(10);
		const redelivered = events.filter(
			(e): e is Extract<DocumentEvent, { type: 'content' }> =>
				e.type === 'content' && e.conflict
		);
		assert.equal(redelivered.length, 1);
		assert.equal(redelivered[0]?.generation, 3);
		// Our own generation is kept: the foreign write surfaced, not adopted.
		assert.equal(doc.generation, 2);
		assert.equal(doc.dirty, true);
		doc.close();
	});

	it('our own echo inside the window is absorbed, not re-delivered', async () => {
		const g = createGatedHost(baseNode);
		const doc = await createOpenDocument(g.host, 'f1');
		const events: DocumentEvent[] = [];
		doc.subscribe((e) => events.push(e));
		doc.markDirty();
		g.holdGate();
		const saved = doc.save({ v: 2 });
		// gen 2 is exactly our own echo's settled generation.
		g.bump(2);
		g.poll();
		const release2 = g.openGate();
		release2!();
		await saved;
		await wait(10);
		assert.equal(events.filter((e) => e.type === 'content' && e.conflict).length, 0);
		assert.equal(doc.dirty, false);
		doc.close();
	});

	it('a foreign write during a clean save window is re-delivered as an adoption', async () => {
		const g = createGatedHost(baseNode);
		const doc = await createOpenDocument(g.host, 'f1');
		const events: DocumentEvent[] = [];
		doc.subscribe((e) => events.push(e));
		g.holdGate();
		const saved = doc.save({ v: 2 });
		g.bump(3);
		g.poll();
		const release3 = g.openGate();
		release3!();
		await saved;
		await wait(10);
		const adopted = events.filter(
			(e): e is Extract<DocumentEvent, { type: 'content' }> =>
				e.type === 'content' && !e.conflict
		);
		assert.equal(adopted.length, 1);
		assert.equal(adopted[0]?.generation, 3);
		assert.equal(doc.generation, 3);
		doc.close();
	});
});
