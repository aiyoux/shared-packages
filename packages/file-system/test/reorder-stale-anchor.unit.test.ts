import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs } from '../src/index.ts';

/**
 * A drag anchor is captured when the drag starts. Delete that row in another
 * tab before the drop and `beforeId` names a node that is gone — which used to
 * leave both order bounds null, so the item landed at sortOrder 0: the top of
 * the list, colliding with the first slot a rebalance hands out.
 */
describe('reorder with an anchor that no longer exists', () => {
	async function threeFiles() {
		const vfs = createVfs({ name: `reorder-${crypto.randomUUID()}` });
		await vfs.ready();
		const root = await vfs.mkdir(null, 'dir');
		const mk = (name: string) =>
			vfs.writeFile({ parentId: root.id, name, body: new Uint8Array([1]) });
		const a = await mk('a.txt');
		const b = await mk('b.txt');
		const c = await mk('c.txt');
		return { vfs, root, a, b, c };
	}

	const names = async (vfs: Awaited<ReturnType<typeof createVfs>>, parentId: string) =>
		(await vfs.list({ parentId, sort: 'order' })).map((n) => n.name);

	it('does not send the item to the top when the anchor is gone', async () => {
		const { vfs, root, a, b, c } = await threeFiles();
		assert.deepEqual(await names(vfs, root.id), ['a.txt', 'b.txt', 'c.txt']);

		await vfs.permanentDelete(c.id);
		// The user aimed at a position beside `c`, which no longer exists.
		await vfs.reorder(a.id, { beforeId: c.id });

		const after = await names(vfs, root.id);
		assert.equal(after[0], 'b.txt', 'the survivor keeps its place at the top');
		assert.equal(after.at(-1), 'a.txt', 'the dropped item appends rather than jumping to the front');
		void b;
	});

	it('still honours an anchor that does exist', async () => {
		const { vfs, root, a, c } = await threeFiles();
		// `beforeId` names the sibling that should end up *before* the moved
		// node — so this puts `c` directly after `a`.
		await vfs.reorder(c.id, { beforeId: a.id });
		assert.deepEqual(await names(vfs, root.id), ['a.txt', 'c.txt', 'b.txt']);
	});
});
