import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests } from '../src/index.ts';
import { observeLiveLink, type LiveLinkSnapshot } from '../src/liveLink.ts';
import type { DocumentEvent } from '../src/types.ts';

function wait(ms = 30): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
	snaps: LiveLinkSnapshot[],
	pred: (s: LiveLinkSnapshot) => boolean,
	ms = 400
): Promise<LiveLinkSnapshot> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const hit = [...snaps].reverse().find(pred);
		if (hit) return hit;
		await wait(15);
	}
	throw new Error(`timeout waiting for live-link state; last=${JSON.stringify(snaps.at(-1))}`);
}

describe('observeLiveLink', () => {
	let vfs: ReturnType<typeof createVfs>;

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({
			dbName: `live-link-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	it('trash → trashed; restore → live', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'clip.png',
			fileType: 'image',
			body: new Uint8Array([1, 2, 3])
		});
		const snaps: LiveLinkSnapshot[] = [];
		const unsub = observeLiveLink(vfs, f.id, (s) => snaps.push(s), {
			generation: f.generation,
			blobId: f.blobId
		});
		await waitFor(snaps, (s) => s.state === 'live');
		await vfs.trash(f.id);
		const trashed = await waitFor(snaps, (s) => s.state === 'trashed');
		assert.equal(trashed.node?.id, f.id);
		assert.ok(trashed.node?.deletedAt != null);
		await vfs.restore(f.id);
		const live = await waitFor(snaps, (s) => s.state === 'live' && s.node?.deletedAt == null);
		assert.equal(live.node?.id, f.id);
		unsub();
	});

	it('permanentDelete → missing', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'gone.png',
			fileType: 'image',
			body: new Uint8Array([1])
		});
		const snaps: LiveLinkSnapshot[] = [];
		const unsub = observeLiveLink(vfs, f.id, (s) => snaps.push(s), {
			generation: f.generation,
			blobId: f.blobId
		});
		await waitFor(snaps, (s) => s.state === 'live');
		await vfs.permanentDelete(f.id);
		const missing = await waitFor(snaps, (s) => s.state === 'missing');
		assert.equal(missing.node, undefined);
		unsub();
	});

	it('writeFile({id}) after delete with new blobId → replaced', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'recycle.png',
			fileType: 'image',
			body: new Uint8Array([1, 2])
		});
		const snaps: LiveLinkSnapshot[] = [];
		const unsub = observeLiveLink(vfs, f.id, (s) => snaps.push(s), {
			generation: f.generation,
			blobId: f.blobId
		});
		await waitFor(snaps, (s) => s.state === 'live');
		await vfs.permanentDelete(f.id);
		await waitFor(snaps, (s) => s.state === 'missing');
		const recycled = await vfs.writeFile({
			id: f.id,
			parentId: null,
			name: 'other.png',
			fileType: 'image',
			body: new Uint8Array([9, 9, 9])
		});
		assert.notEqual(recycled.blobId, f.blobId);
		const replaced = await waitFor(snaps, (s) => s.state === 'replaced');
		assert.equal(replaced.node?.id, f.id);
		assert.equal(replaced.node?.blobId, recycled.blobId);
		unsub();
	});
});

describe('subscribeNode trash/restore', () => {
	let vfs: ReturnType<typeof createVfs>;

	beforeEach(async () => {
		resetSharedVfsForTests();
		vfs = createVfs({
			dbName: `sub-node-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	it('emits deleted on trash and unsubscribes so restore is not an event', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'w.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const events: DocumentEvent[] = [];
		const unsub = vfs.subscribeNode(f.id, (e) => events.push(e));
		await vfs.trash(f.id);
		await wait(40);
		assert.ok(events.some((e) => e.type === 'deleted' && e.reason === 'trash'));
		const afterTrash = events.length;
		await vfs.restore(f.id);
		await wait(40);
		assert.equal(events.length, afterTrash, 'restore must not emit after subscribeNode unsubscribed');
		unsub();
	});

	it('emits deleted on permanentDelete', async () => {
		const f = await vfs.writeFile({
			parentId: null,
			name: 'p.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		const events: DocumentEvent[] = [];
		vfs.subscribeNode(f.id, (e) => events.push(e));
		await vfs.permanentDelete(f.id);
		await wait(40);
		assert.ok(events.some((e) => e.type === 'deleted' && e.reason === 'permanent'));
	});
});
