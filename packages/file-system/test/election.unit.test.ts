import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElection, type Election, type ElectionChannel } from '../src/live/election.ts';
import { createFakeLifecycle, installLockPolyfill, tick, type LockHarness } from './live-locks-harness.ts';

/** In-memory BroadcastChannel: delivers to every other member, asynchronously. */
function channelHub() {
	const members = new Set<{ fns: Set<(e: { data?: unknown }) => void> }>();
	return {
		open(): ElectionChannel {
			const me = { fns: new Set<(e: { data?: unknown }) => void>() };
			members.add(me);
			return {
				postMessage(message) {
					for (const m of members) {
						if (m === me) continue;
						for (const fn of [...m.fns]) queueMicrotask(() => fn({ data: message }));
					}
				},
				addEventListener: (_t, fn) => me.fns.add(fn),
				removeEventListener: (_t, fn) => me.fns.delete(fn),
				close: () => members.delete(me)
			};
		}
	};
}

let lockEnv: LockHarness;
let hub: ReturnType<typeof channelHub>;
let clock = 1_000;
const open: Election[] = [];

function tab(id: string, extra: Parameters<typeof createElection>[1] = {}): Election {
	const e = createElection('test-lock', {
		tabId: id,
		channel: hub.open(),
		window: null,
		document: null,
		locks: (globalThis as unknown as { navigator: { locks: never } }).navigator.locks,
		now: () => clock,
		...extra
	});
	open.push(e);
	return e;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await tick();
}

beforeEach(() => {
	lockEnv = installLockPolyfill();
	hub = channelHub();
	clock = 1_000;
});

afterEach(() => {
	for (const e of open.splice(0)) e.destroy();
	lockEnv.reset();
});

describe('createElection', () => {
	it('decides "not leader" from the lock itself, with no grace period', async () => {
		const a = tab('a');
		await settle();
		assert.equal(a.state, 'leader');
		const b = tab('b');
		assert.equal(b.state, 'deciding');
		// One lock round trip: no timer is involved in reaching "follower".
		await tick();
		await tick();
		assert.equal(b.state, 'follower');
	});

	it('a follower learns who leads, and when that leader is gone', async () => {
		const a = tab('a');
		await settle();
		const b = tab('b');
		const c = tab('c');
		await settle();
		assert.equal(b.leader?.tabId, 'a');
		assert.equal(b.leader?.term, a.term);
		assert.equal(c.leader?.tabId, 'a');

		clock = 5_000;
		a.destroy();
		await settle();
		// One of them was next in the queue; the other got the death notice
		// and then the new leader's announcement. Neither waited on a clock.
		const next = b.isLeader ? b : c;
		const other = next === b ? c : b;
		assert.equal(next.isLeader, true);
		assert.equal(other.state, 'follower');
		assert.equal(other.leader?.tabId, next.tabId);
		assert.equal(other.leader?.term, next.term);
		assert.ok(next.term > 1_000, 'a new term is past every term heard');
	});

	it('takeOver() makes this tab leader and the old one a follower', async () => {
		const a = tab('a');
		await settle();
		const b = tab('b');
		await settle();
		b.takeOver();
		await settle();
		assert.equal(b.isLeader, true);
		assert.equal(a.isLeader, false);
		assert.equal(a.state, 'follower');
		assert.equal(a.leader?.tabId, 'b');
		// The old leader rejoined the queue: it takes over again when b goes.
		b.destroy();
		await settle();
		assert.equal(a.isLeader, true);
	});

	it('a frozen leader that is taken over comes back as a follower', async () => {
		let abandoned = 0;
		const a = tab('a', { abandon: () => (abandoned += 1) });
		await settle();
		// A third tab that has heard of a, to check what it believes.
		const c = tab('c');
		await settle();
		const b = tab('b');
		await settle();

		lockEnv.freezeVictims();
		clock = 9_000;
		b.takeOver();
		await settle();
		assert.equal(b.isLeader, true);
		assert.equal(c.leader?.tabId, 'b', 'the other tabs follow the new term');

		lockEnv.thaw();
		await settle();
		assert.equal(a.isLeader, false);
		assert.equal(a.leader?.tabId, 'b');
		assert.equal(abandoned, 1, 'the old leader tore down what it was serving');
	});

	it('ignores an announcement from an older term', async () => {
		const a = tab('a');
		await settle();
		const c = tab('c');
		await settle();
		clock = 9_000;
		const b = tab('b');
		b.takeOver();
		await settle();
		assert.equal(c.leader?.tabId, 'b');
		// A stale leader's message arriving late must not win the follower back.
		const stale = hub.open();
		stale.postMessage({ t: 'leader', id: 'a:1', tabId: 'a', term: 1_000 });
		await settle();
		assert.equal(c.leader?.tabId, 'b');
		assert.equal(a.isLeader, false);
	});

	it('a tab that cannot start leading gives the lock back and says why', async () => {
		const a = tab('a', { prepare: () => false });
		const b = tab('b', { prepare: async () => true });
		await settle();
		assert.equal(a.isLeader, false);
		assert.equal(b.isLeader, true, 'the next tab in the queue took it');
		assert.equal(b.failure, null);

		const c = tab('c', { prepare: () => Promise.reject(new Error('wasm missing')) });
		await settle();
		b.destroy();
		await settle();
		assert.equal(c.isLeader, false);
		assert.equal(c.failure, 'wasm missing');
	});

	it('stands down on freeze and rejoins on resume', async () => {
		const life = createFakeLifecycle();
		let abandoned = 0;
		const a = tab('a', {
			document: life.target as never,
			abandon: () => (abandoned += 1)
		});
		await settle();
		const b = tab('b');
		await settle();
		life.fire('freeze');
		await settle();
		assert.equal(a.isLeader, false);
		assert.equal(abandoned, 1);
		assert.equal(b.isLeader, true);
		life.fire('resume');
		await settle();
		assert.equal(a.state, 'follower');
		assert.equal(a.leader?.tabId, 'b');
	});

	it('tears down cleanly before letting go on an ordinary pagehide', async () => {
		const life = createFakeLifecycle();
		const order: string[] = [];
		const a = tab('a', {
			window: life.target as never,
			teardown: async () => {
				await tick();
				order.push('teardown');
			}
		});
		await settle();
		const b = tab('b', {
			prepare: () => {
				order.push('b-prepare');
				return true;
			}
		});
		await settle();
		life.fire('pagehide', { persisted: false });
		await settle();
		assert.deepEqual(order, ['teardown', 'b-prepare']);
		assert.equal(b.isLeader, true);
	});

	it('yields while hidden when asked to, so a visible tab leads', async () => {
		const life = createFakeLifecycle();
		const doc = { ...life.target, visibilityState: 'visible' };
		const a = tab('a', { document: doc as never, yieldWhenHidden: true });
		await settle();
		const b = tab('b');
		await settle();
		doc.visibilityState = 'hidden';
		life.fire('visibilitychange');
		await settle();
		assert.equal(b.isLeader, true);
		assert.equal(a.state, 'follower');
	});
});

describe('createElection while starting', () => {
	it('a tab released mid-prepare tears down what it started and never leads', async () => {
		let finishPrepare!: (ok: boolean) => void;
		const events: string[] = [];
		const a = tab('a', {
			prepare: () =>
				new Promise<boolean>((r) => {
					events.push('prepare');
					finishPrepare = r;
				}),
			teardown: () => {
				events.push('teardown');
			}
		});
		await settle();
		assert.deepEqual(events, ['prepare']);
		a.release();
		finishPrepare(true);
		await settle();
		assert.equal(a.isLeader, false);
		assert.ok(events.includes('teardown'), 'what prepare started was left running');
		const b = tab('b');
		await settle();
		assert.equal(b.isLeader, true, 'the lock went back');
	});

	it('takeOver on a tab that already holds the lock is a no-op', async () => {
		const a = tab('a');
		await settle();
		a.takeOver();
		await settle();
		assert.equal(a.isLeader, true);
	});
});
