import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { VfsError } from '../src/types.ts';
import { createVfs, getSharedVfs, resetSharedVfsForTests } from '../src/index.ts';
import { createDocSession, type DocSessionHold } from '../src/docSession.ts';

type Doc = { v: number };

function parse(bytes: Uint8Array): Doc {
	return JSON.parse(new TextDecoder().decode(bytes)) as Doc;
}
function serialize(doc: Doc): string {
	return JSON.stringify(doc);
}

describe('doc session hold', () => {
	let vfs: ReturnType<typeof createVfs>;

	beforeEach(async () => {
		resetSharedVfsForTests();
		// The singleton: createDocSession.retain() resolves its own VFS through
		// getSharedVfs(), so seeding it here is what makes the hold hit this db.
		vfs = getSharedVfs({
			dbName: `doc-hold-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
	});

	async function boot(initial: Doc) {
		const f = await vfs.writeFile({
			parentId: null,
			name: `hold-${Math.random().toString(36).slice(2)}.skch`,
			fileType: 'skch',
			body: initial
		});
		const session = createDocSession<Doc>({
			empty: () => ({ v: 0 }),
			parse,
			serialize
		});
		const hold = await session.retain(f.id);
		// Gate the inner save so the test can inject work mid-window (real
		// timers — the window this suite exists to exercise must not collapse),
		// and count entries so a no-write test can prove the inner save was
		// never reached.
		let calls = 0;
		const original = hold.doc.save.bind(hold.doc);
		(hold.doc as unknown as { save: unknown }).save = async (
			body: unknown,
			opts?: unknown
		) => {
			calls += 1;
			return original(body, opts as never);
		};
		return { f, session, hold, calls: () => calls };
	}

	it('an edit landing mid-save keeps the hold dirty and the follow-up save converges', async () => {
		const { f, session, hold } = await boot({ v: 1 });
		hold.value = { v: 2 };
		session.markDirty(hold);
		const saved = session.save(hold);
		// Mid-window: the user keeps editing while the {v:2} write is in flight.
		await new Promise((r) => setTimeout(r, 10));
		hold.value = { v: 3 };
		session.markDirty(hold);
		await saved;
		// The {v:2} write resolved but an edit landed during it: nothing may
		// claim clean here.
		assert.equal(hold.dirty, true);
		assert.equal(hold.doc.dirty, true);
		// Follow-up save writes the mid-window edit and converges clean.
		await session.save(hold);
		assert.equal(hold.dirty, false);
		assert.equal(hold.doc.dirty, false);
		assert.deepEqual(await vfs.readJson(f.id), { v: 3 });
		session.release(f.id);
	});

	it('a no-change save on a dirty hold writes nothing and stays dirty', async () => {
		const { f, session, hold, calls } = await boot({ v: 1 });
		session.markDirty(hold); // dirty without changing the value
		await session.save(hold);
		assert.equal(calls(), 0, 'no write was attempted');
		assert.equal(hold.dirty, true, 'a dirty hold is not cleaned by a write that never happened');
		assert.equal(hold.doc.dirty, true);
		assert.deepEqual(await vfs.readJson(f.id), { v: 1 });
		session.release(f.id);
	});

	it('a clean no-change save claims clean without reaching the VFS', async () => {
		const { f, session, hold, calls } = await boot({ v: 1 });
		await session.save(hold);
		assert.equal(calls(), 0, 'no write was attempted');
		assert.equal(hold.dirty, false);
		assert.equal(hold.doc.dirty, false);
		assert.deepEqual(await vfs.readJson(f.id), { v: 1 });
		session.release(f.id);
	});

	it('unchanged serialization over a moved generation refuses instead of claiming clean', async () => {
		const { f, session, hold } = await boot({ v: 1 });
		session.markDirty(hold); // dirty, value unchanged: serialization still matches disk
		// White-box: simulate a foreign write the hold has not adopted — the
		// claimant's generation has moved off the hold's stale anchor while the
		// serialization still matches it. The old gate skipped the CAS and
		// claimed clean over exactly this state.
		(hold as { generation: number }).generation = hold.generation - 1;
		await assert.rejects(
			() => session.save(hold),
			(e: unknown) => e instanceof VfsError && e.code === 'GENERATION_CONFLICT'
		);
		assert.equal(hold.dirty, true, 'the refused save claims nothing');
		assert.deepEqual(await vfs.readJson(f.id), { v: 1 });
		session.release(f.id);
	});

	it('a mid-save edit that reverts to the on-disk value is still written by the next save', async () => {
		const { f, session, hold } = await boot({ v: 1 });
		hold.value = { v: 2 };
		session.markDirty(hold);
		const saved = session.save(hold);
		await new Promise((r) => setTimeout(r, 10));
		// Undo back to the on-disk value mid-window: the in-flight write lands
		// {v:2} anyway, so the hold's new savedFingerprint names {v:2} — the
		// reverted {v:1} must not be gated away as "already saved".
		hold.value = { v: 1 };
		session.markDirty(hold);
		await saved;
		await session.save(hold);
		assert.equal(hold.dirty, false);
		assert.deepEqual(await vfs.readJson(f.id), { v: 1 });
		session.release(f.id);
	});

	it('a clean foreign adoption refreshes the hold, then a real save writes normally', async () => {
		const { f, session, hold, calls } = await boot({ v: 1 });
		const current = await vfs.get(f.id);
		await vfs.updateFile(f.id, { v: 9 }, { expectedGeneration: current!.generation });
		// Wait out the watcher: clean adoption re-parses bytes and refreshes
		// savedFingerprint, so the next no-change save is a no-op, not a
		// stale-body write over the foreign content.
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(hold.error, '');
		assert.deepEqual(hold.value, { v: 9 });
		await session.save(hold); // no-change: gated, no write
		assert.equal(calls(), 0);
		assert.deepEqual(await vfs.readJson(f.id), { v: 9 });
		hold.value = { v: 10 };
		session.markDirty(hold);
		await session.save(hold);
		assert.deepEqual(await vfs.readJson(f.id), { v: 10 });
		assert.equal(hold.dirty, false);
		session.release(f.id);
	});
});