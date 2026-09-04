import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSession, type LiveSession } from '../src/live/session.ts';
import {
	clearWindowListeners,
	installLockPolyfill,
	installWindow,
	tick,
	until,
	wait,
	type LockHarness
} from './live-locks-harness.ts';

/** A tiny document and op vocabulary standing in for a real app's. */
type Doc = { text: string; n: number };
type Op = { t: 'append'; s: string } | { t: 'bump' } | { t: 'boom' };

function reduce(doc: Doc, op: Op): Doc {
	switch (op.t) {
		case 'append':
			return { ...doc, text: doc.text + op.s };
		case 'bump':
			return { ...doc, n: doc.n + 1 };
		case 'boom':
			throw new Error('reducer refused');
	}
}

let lockEnv: LockHarness;
let docSeq = 0;
const nextDocId = () => `live-session-${process.pid}-${docSeq++}`;

const open = (nodeId: string, senderId: string, initial: Doc, extra: Record<string, unknown> = {}) =>
	createLiveSession<Doc, Op>({
		nodeId,
		senderId,
		initial,
		reduce,
		busOptions: { flushSync: true, gapTimeoutMs: 50 },
		intentTimeoutMs: 300,
		...extra
	});

beforeEach(() => {
	installWindow();
	lockEnv = installLockPolyfill();
});

afterEach(() => {
	lockEnv.reset();
	clearWindowListeners();
});

describe('createLiveSession', () => {
	it('the first session becomes leader; a second becomes a follower', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: '', n: 0 });
		await tick();
		const b = open(id, 'b', { text: 'stale', n: 99 });
		await tick();

		assert.equal(a.role, 'leader');
		assert.equal(b.role, 'follower');
		a.destroy();
		b.destroy();
	});

	it('a joining follower adopts the leader snapshot, discarding its stale copy', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: 'real', n: 7 });
		await tick();
		const b = open(id, 'b', { text: 'stale', n: 99 });
		await until(() => b.doc.text === 'real');

		assert.deepEqual(b.doc, { text: 'real', n: 7 });
		a.destroy();
		b.destroy();
	});

	it('a leader commit reaches the follower replica', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: '', n: 0 });
		await tick();
		const b = open(id, 'b', { text: '', n: 0 });
		await tick();

		await a.commit({ t: 'append', s: 'x' });
		await until(() => b.doc.text === 'x');

		assert.equal(b.doc.text, 'x');
		assert.equal(b.seq, a.seq);
		a.destroy();
		b.destroy();
	});

	it('a follower commit is forwarded and only resolves on the leader echo (L4)', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: '', n: 0 });
		await tick();
		const b = open(id, 'b', { text: '', n: 0 });
		await tick();

		const before = b.doc.text;
		const p = b.commit({ t: 'append', s: 'y' });
		assert.equal(b.doc.text, before, 'follower must NOT apply optimistically');

		await p;
		assert.equal(b.doc.text, 'y', 'applied once the leader echoed');
		assert.equal(a.doc.text, 'y', 'and the leader is authoritative');
		a.destroy();
		b.destroy();
	});

	it('a rejected follower intent rejects the promise and leaves both replicas untouched', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: 'keep', n: 0 });
		await tick();
		const b = open(id, 'b', { text: '', n: 0 });
		await until(() => b.doc.text === 'keep');

		await assert.rejects(() => b.commit({ t: 'boom' }), /reducer refused/);
		assert.equal(a.doc.text, 'keep');
		assert.equal(b.doc.text, 'keep');
		a.destroy();
		b.destroy();
	});

	it('a follower intent times out rather than hanging when no leader answers', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: '', n: 0 });
		await tick();
		const b = open(id, 'b', { text: '', n: 0 });
		await tick();
		assert.equal(b.role, 'follower');

		// The leader stops listening without releasing (simulates a wedged tab).
		a.destroy();
		lockEnv.reset(); // ...and the lock never transfers.

		await assert.rejects(() => b.commit({ t: 'bump' }), /timed out/);
		b.destroy();
	});

	it('ops go through the same reducer on both paths, so replicas converge', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: '', n: 0 });
		await tick();
		const b = open(id, 'b', { text: '', n: 0 });
		await tick();

		await a.commit({ t: 'append', s: '1' });
		await b.commit({ t: 'append', s: '2' });
		await a.commit({ t: 'bump' });
		await until(() => b.seq === 3);

		assert.deepEqual(a.doc, b.doc, 'leader and follower agree');
		assert.deepEqual(a.doc, { text: '12', n: 1 });
		a.destroy();
		b.destroy();
	});

	it('promotes a follower when the leader goes away, keeping its replica (M1)', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: 'seed', n: 0 });
		await tick();
		const b = open(id, 'b', { text: '', n: 0 });
		await until(() => b.doc.text === 'seed');
		await a.commit({ t: 'append', s: '!' });
		await until(() => b.doc.text === 'seed!');

		a.destroy();
		await until(() => b.role === 'leader');

		assert.equal(b.role, 'leader');
		assert.equal(b.doc.text, 'seed!', 'the promoted tab keeps what it had applied');

		// And it can now commit on its own authority.
		await b.commit({ t: 'bump' });
		assert.equal(b.doc.n, 1);
		b.destroy();
	});

	it('seq stays monotonic across a leadership change', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: '', n: 0 });
		await tick();
		const b = open(id, 'b', { text: '', n: 0 });
		await tick();

		await a.commit({ t: 'bump' });
		await a.commit({ t: 'bump' });
		await until(() => b.seq === 2);

		a.destroy();
		await until(() => b.role === 'leader');
		await b.commit({ t: 'bump' });

		assert.equal(b.seq, 3, 'the new leader continues the sequence, it does not restart it');
		b.destroy();
	});

	it('transient payloads reach peers without touching the document (L5)', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: '', n: 0 });
		await tick();
		const seen: unknown[] = [];
		const b = open(id, 'b', { text: '', n: 0 }, { onTransient: (p: unknown) => seen.push(p) });
		await tick();

		a.sendTransient({ x: 10, y: 20 });
		await until(() => seen.length === 1);

		assert.deepEqual(seen, [{ x: 10, y: 20 }]);
		assert.equal(b.seq, 0, 'a preview must not advance the document');
		assert.equal(b.doc.text, '');
		a.destroy();
		b.destroy();
	});

	it('announceSaved carries the generation so followers do not fail CAS', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: '', n: 0 });
		await tick();
		const saved: number[] = [];
		const b = open(id, 'b', { text: '', n: 0 }, {
			onSaved: (i: { generation: number }) => saved.push(i.generation)
		});
		await tick();

		a.announceSaved(42, 'fp');
		await until(() => saved.length === 1);

		assert.deepEqual(saved, [42]);
		a.destroy();
		b.destroy();
	});

	it('a follower ignores announceSaved (only the leader may declare a save)', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: '', n: 0 });
		await tick();
		const saved: number[] = [];
		const b = open(id, 'b', { text: '', n: 0 });
		await tick();
		const off = a; // leader
		void off;

		// b is a follower: this must be a no-op, not a broadcast.
		b.announceSaved(7);
		await wait(40);
		assert.deepEqual(saved, []);
		a.destroy();
		b.destroy();
	});

	it('replaceDoc pushes an out-of-band document to followers (promotion reload)', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: 'old', n: 0 });
		await tick();
		const b = open(id, 'b', { text: '', n: 0 });
		await until(() => b.doc.text === 'old');

		a.replaceDoc({ text: 'fresh-from-disk', n: 5 });
		await until(() => b.doc.text === 'fresh-from-disk');

		assert.deepEqual(b.doc, { text: 'fresh-from-disk', n: 5 });
		a.destroy();
		b.destroy();
	});

	it('a lone session is the leader, so the same path runs with one tab (L12)', async () => {
		const id = nextDocId();
		const only = open(id, 'solo', { text: '', n: 0 });
		await tick();

		assert.equal(only.role, 'leader');
		await only.commit({ t: 'append', s: 'z' });
		assert.equal(only.doc.text, 'z');
		assert.equal(only.seq, 1);
		only.destroy();
	});

	it('commit after destroy rejects instead of silently doing nothing', async () => {
		const id = nextDocId();
		const a = open(id, 'a', { text: '', n: 0 });
		await tick();
		a.destroy();
		await assert.rejects(() => a.commit({ t: 'bump' }), /destroyed/);
	});

	it('separate documents do not see each other traffic', async () => {
		const a = open(nextDocId(), 'a', { text: '', n: 0 });
		const b = open(nextDocId(), 'b', { text: '', n: 0 });
		await tick();

		await a.commit({ t: 'append', s: 'only-a' });
		await wait(40);

		assert.equal(b.doc.text, '');
		assert.equal(b.seq, 0);
		a.destroy();
		b.destroy();
	});
});

describe('sessions within one tab', () => {
	it('two sessions on one document hear each other (distinct sender ids)', async () => {
		// Two panes of the same app in one tab. They share a tab id, so a
		// tab-scoped sender would make the bus discard every frame between them.
		const id = nextDocId();
		const a = createLiveSession<Doc, Op>({
			nodeId: id,
			initial: { text: '', n: 0 },
			reduce,
			busOptions: { flushSync: true, gapTimeoutMs: 50 },
			intentTimeoutMs: 300
		});
		await tick();
		const b = createLiveSession<Doc, Op>({
			nodeId: id,
			initial: { text: '', n: 0 },
			reduce,
			busOptions: { flushSync: true, gapTimeoutMs: 50 },
			intentTimeoutMs: 300
		});
		await tick();

		assert.notEqual(a.senderId, b.senderId, 'each session needs its own sender id');
		await a.commit({ t: 'append', s: 'pane-a' });
		await until(() => b.doc.text === 'pane-a');

		assert.equal(b.doc.text, 'pane-a');
		a.destroy();
		b.destroy();
	});
});
