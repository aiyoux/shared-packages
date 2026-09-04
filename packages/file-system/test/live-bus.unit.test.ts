import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveBus, type LiveEnvelope } from '../src/live/bus.ts';

type Msg = { kind: 'commit' | 'pose'; n: number };

const isImmediate = (m: Msg) => m.kind === 'pose';

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `fn()` is true or the deadline passes. */
async function until(fn: () => boolean, ms = 1000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!fn() && Date.now() < deadline) await wait(5);
}

let channelSeq = 0;
const nextChannel = () => `live-bus-test-${process.pid}-${channelSeq++}`;

/**
 * Post raw envelopes as some other sender, bypassing the bus's own outgoing
 * path. Out-of-order and duplicate sequences are what we need to exercise, and
 * a well-behaved bus never produces them.
 */
function rawPoster(channelName: string) {
	const ch = new BroadcastChannel(channelName);
	(ch as BroadcastChannel & { unref?: () => void }).unref?.();
	return {
		send(...envelopes: LiveEnvelope<Msg>[]) {
			ch.postMessage(envelopes);
		},
		close: () => ch.close()
	};
}

describe('createLiveBus', () => {
	it('delivers a sequenced message to another instance on the channel', async () => {
		const name = nextChannel();
		const a = createLiveBus<Msg>(name, 'a', { isImmediate, flushSync: true });
		const b = createLiveBus<Msg>(name, 'b', { isImmediate, flushSync: true });
		const got: Msg[] = [];
		b.onMessage((m) => got.push(m));

		a.broadcast({ kind: 'commit', n: 1 });
		await until(() => got.length === 1);

		assert.deepEqual(got, [{ kind: 'commit', n: 1 }]);
		a.destroy();
		b.destroy();
	});

	it('does not echo to the sending instance (M11)', async () => {
		const name = nextChannel();
		const a = createLiveBus<Msg>(name, 'a', { isImmediate, flushSync: true });
		const seen: Msg[] = [];
		a.onMessage((m) => seen.push(m));

		a.broadcast({ kind: 'commit', n: 1 });
		await wait(60);

		assert.deepEqual(seen, [], 'a bus must not hear its own broadcast');
		a.destroy();
	});

	it('batches a burst into one post per frame (M9)', async () => {
		const name = nextChannel();
		// flushSync off, so the batching path is what runs.
		const a = createLiveBus<Msg>(name, 'a', { isImmediate });
		const b = createLiveBus<Msg>(name, 'b', { isImmediate });
		let batches = 0;
		const got: Msg[] = [];
		const spy = new BroadcastChannel(name);
		(spy as BroadcastChannel & { unref?: () => void }).unref?.();
		spy.addEventListener('message', () => {
			batches += 1;
		});
		b.onMessage((m) => got.push(m));

		a.broadcast({ kind: 'commit', n: 1 });
		a.broadcast({ kind: 'commit', n: 2 });
		a.broadcast({ kind: 'commit', n: 3 });
		await until(() => got.length === 3);

		assert.equal(got.length, 3, 'every message still arrives');
		assert.equal(batches, 1, 'three broadcasts in one tick cost one postMessage');
		spy.close();
		a.destroy();
		b.destroy();
	});

	it('buffers an out-of-order message and flushes it when the gap fills', async () => {
		const name = nextChannel();
		const b = createLiveBus<Msg>(name, 'b', { isImmediate, gapTimeoutMs: 50 });
		const got: number[] = [];
		b.onMessage((m) => got.push(m.n));
		const raw = rawPoster(name);

		raw.send({ sender: 'a', seq: 1, msg: { kind: 'commit', n: 1 } });
		await until(() => got.length === 1);
		// seq 2 is missing; 3 must wait rather than be delivered early.
		raw.send({ sender: 'a', seq: 3, msg: { kind: 'commit', n: 3 } });
		await wait(20);
		assert.deepEqual(got, [1], 'out-of-order message must not jump the queue');

		raw.send({ sender: 'a', seq: 2, msg: { kind: 'commit', n: 2 } });
		await until(() => got.length === 3);
		assert.deepEqual(got, [1, 2, 3], 'buffered message drains in order');

		raw.close();
		b.destroy();
	});

	it('abandons a gap after the deadline rather than wedging forever (M7)', async () => {
		const name = nextChannel();
		const b = createLiveBus<Msg>(name, 'b', { isImmediate, gapTimeoutMs: 40 });
		const got: number[] = [];
		b.onMessage((m) => got.push(m.n));
		const raw = rawPoster(name);

		raw.send({ sender: 'a', seq: 1, msg: { kind: 'commit', n: 1 } });
		await until(() => got.length === 1);
		// seq 2 never arrives.
		raw.send({ sender: 'a', seq: 3, msg: { kind: 'commit', n: 3 } });
		await until(() => got.length === 2, 500);

		assert.deepEqual(got, [1, 3], 'buffered message is released once the gap is abandoned');

		// And the sender is resynchronised past the hole, so later messages
		// flow immediately instead of piling up behind the dead seq.
		raw.send({ sender: 'a', seq: 4, msg: { kind: 'commit', n: 4 } });
		await until(() => got.length === 3);
		assert.deepEqual(got, [1, 3, 4]);

		raw.close();
		b.destroy();
	});

	it('force-flushes when the out-of-order buffer hits its cap (M7)', async () => {
		const name = nextChannel();
		// A deadline long enough that only the cap can explain a flush.
		const b = createLiveBus<Msg>(name, 'b', { isImmediate, gapTimeoutMs: 60_000 });
		const got: number[] = [];
		b.onMessage((m) => got.push(m.n));
		const raw = rawPoster(name);

		raw.send({ sender: 'a', seq: 1, msg: { kind: 'commit', n: 1 } });
		await until(() => got.length === 1);

		// seq 2 is missing; pile 256 later ones behind it.
		const flood: LiveEnvelope<Msg>[] = [];
		for (let i = 0; i < 256; i++) {
			flood.push({ sender: 'a', seq: 3 + i, msg: { kind: 'commit', n: 3 + i } });
		}
		raw.send(...flood);
		await until(() => got.length > 1, 2000);

		assert.equal(got.length, 257, 'the whole buffer drains on the cap');
		assert.equal(got[1], 3, 'in ascending order, skipping the dead seq');

		raw.close();
		b.destroy();
	});

	it('immediate messages bypass sequencing entirely (M8)', async () => {
		const name = nextChannel();
		const b = createLiveBus<Msg>(name, 'b', { isImmediate, gapTimeoutMs: 60_000 });
		const got: Msg[] = [];
		b.onMessage((m) => got.push(m));
		const raw = rawPoster(name);

		raw.send({ sender: 'a', seq: 1, msg: { kind: 'commit', n: 1 } });
		await until(() => got.length === 1);
		// Open a gap that would block any sequenced message...
		raw.send({ sender: 'a', seq: 5, msg: { kind: 'commit', n: 5 } });
		// ...a transient pose must still arrive immediately.
		raw.send({ sender: 'a', msg: { kind: 'pose', n: 99 } });
		await until(() => got.length === 2);

		assert.deepEqual(
			got.map((m) => m.kind),
			['commit', 'pose'],
			'a pose is not held behind a commit gap'
		);
		raw.close();
		b.destroy();
	});

	it('discards stale and duplicate sequence numbers', async () => {
		const name = nextChannel();
		const b = createLiveBus<Msg>(name, 'b', { isImmediate, gapTimeoutMs: 50 });
		const got: number[] = [];
		b.onMessage((m) => got.push(m.n));
		const raw = rawPoster(name);

		raw.send(
			{ sender: 'a', seq: 1, msg: { kind: 'commit', n: 1 } },
			{ sender: 'a', seq: 2, msg: { kind: 'commit', n: 2 } }
		);
		await until(() => got.length === 2);
		raw.send({ sender: 'a', seq: 2, msg: { kind: 'commit', n: 22 } }); // duplicate
		raw.send({ sender: 'a', seq: 1, msg: { kind: 'commit', n: 11 } }); // stale
		await wait(40);

		assert.deepEqual(got, [1, 2], 'replays are dropped');
		raw.close();
		b.destroy();
	});

	it('tracks sequences per sender independently', async () => {
		const name = nextChannel();
		const b = createLiveBus<Msg>(name, 'b', { isImmediate, gapTimeoutMs: 60_000 });
		const got: number[] = [];
		b.onMessage((m) => got.push(m.n));
		const raw = rawPoster(name);

		raw.send({ sender: 'x', seq: 1, msg: { kind: 'commit', n: 1 } });
		raw.send({ sender: 'y', seq: 1, msg: { kind: 'commit', n: 2 } });
		await until(() => got.length === 2);
		// A gap from x must not stall y.
		raw.send({ sender: 'x', seq: 3, msg: { kind: 'commit', n: 30 } });
		raw.send({ sender: 'y', seq: 2, msg: { kind: 'commit', n: 3 } });
		await until(() => got.length === 3);

		assert.deepEqual(got, [1, 2, 3], "one sender's gap does not block another");
		raw.close();
		b.destroy();
	});

	it('stops delivering after destroy()', async () => {
		const name = nextChannel();
		const a = createLiveBus<Msg>(name, 'a', { isImmediate, flushSync: true });
		const b = createLiveBus<Msg>(name, 'b', { isImmediate, flushSync: true });
		const got: Msg[] = [];
		b.onMessage((m) => got.push(m));

		b.destroy();
		a.broadcast({ kind: 'commit', n: 1 });
		await wait(60);

		assert.deepEqual(got, []);
		a.destroy();
	});
});
