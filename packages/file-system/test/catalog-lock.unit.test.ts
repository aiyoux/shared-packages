import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogLock, type CatalogLock } from '../src/catalogLock.ts';
import {
	createFakeLifecycle,
	installLockPolyfill,
	tick,
	until,
	type LockHarness
} from './live-locks-harness.ts';

const NAME = 'vfs-catalog-sah';

let lockEnv: LockHarness;

beforeEach(() => {
	lockEnv = installLockPolyfill();
});

afterEach(() => {
	lockEnv.reset();
});

type Tab = {
	lock: CatalogLock;
	life: ReturnType<typeof createFakeLifecycle>;
	calls: { start: number; stop: number; abandon: number; stolen: number };
	/** Let a pending stop() finish, for the clean-exit path. */
	finishStop: () => void;
	startOk: (ok: boolean) => void;
};

function makeTab(opts: { slowStop?: boolean } = {}): Tab {
	const life = createFakeLifecycle();
	const calls = { start: 0, stop: 0, abandon: 0, stolen: 0 };
	let ok = true;
	let release: (() => void) | null = null;
	const locks = (globalThis as unknown as { navigator: { locks: unknown } }).navigator.locks;
	const lock = createCatalogLock({
		name: NAME,
		locks: locks as Parameters<typeof createCatalogLock>[0]['locks'],
		lifecycle: life.target,
		start: async () => {
			calls.start += 1;
			return ok;
		},
		stop: async () => {
			calls.stop += 1;
			if (!opts.slowStop) return;
			await new Promise<void>((r) => {
				release = r;
			});
		},
		abandon: () => {
			calls.abandon += 1;
		},
		onStolen: () => {
			calls.stolen += 1;
		}
	});
	return {
		lock,
		life,
		calls,
		finishStop: () => release?.(),
		startOk: (v: boolean) => {
			ok = v;
		}
	};
}

describe('catalog leadership lock', () => {
	it('probes without waiting, so a second tab can fall back to the leader', async () => {
		const a = makeTab();
		const b = makeTab();
		assert.equal(await a.lock.acquire(), true);

		// The default attempt must answer "no" rather than queue: the caller
		// goes on to talk to the leader over BroadcastChannel.
		assert.equal(await b.lock.acquire(), false);
		assert.equal(b.calls.start, 0);
		assert.equal(a.lock.held, true);
	});

	it('drops the lock synchronously on freeze (H1)', async () => {
		const a = makeTab({ slowStop: true });
		assert.equal(await a.lock.acquire(), true);

		a.life.fire('freeze');

		// Synchronously, in the handler itself — no await. A frozen tab runs no
		// further JS, so anything deferred here would never happen and the lock
		// would be held for the whole freeze.
		assert.equal(a.lock.held, false);
		assert.equal(a.calls.abandon, 1);
		assert.equal(a.calls.stop, 0, 'async teardown cannot be what the release waits on');

		await tick();
		assert.equal(lockEnv.held.get(NAME) ?? false, false);
	});

	it('hands leadership to a queued tab the moment the holder freezes', async () => {
		const a = makeTab();
		const b = makeTab();
		assert.equal(await a.lock.acquire(), true);

		let promoted: boolean | null = null;
		const queued = b.lock.acquire({ waitMs: 2_000 }).then((v) => (promoted = v));
		await tick();
		assert.equal(promoted, null, 'still waiting behind the holder');

		a.life.fire('freeze');
		await queued;

		assert.equal(promoted, true);
		assert.equal(b.lock.held, true);
		assert.equal(b.calls.start, 1);
	});

	it('abandons a queue it cannot win rather than waiting forever (H5)', async () => {
		const a = makeTab();
		const b = makeTab();
		assert.equal(await a.lock.acquire(), true);

		const started = Date.now();
		assert.equal(await b.lock.acquire({ waitMs: 60 }), false);
		assert.ok(Date.now() - started >= 50);
		assert.equal(b.calls.start, 0);
		assert.equal(a.lock.held, true, 'giving up waiting must not disturb the holder');
	});

	it('tears down cleanly before releasing on a real exit (H3)', async () => {
		const a = makeTab({ slowStop: true });
		assert.equal(await a.lock.acquire(), true);

		a.life.fire('pagehide', { persisted: false });
		await tick();

		// The page still runs JS here, so the worker gets to release its SAH
		// pool before the next leader tries to install one.
		assert.equal(a.calls.stop, 1);
		assert.equal(a.lock.held, true, 'lock is held until teardown finishes');

		a.finishStop();
		await until(() => !a.lock.held);
		assert.equal(a.lock.held, false);
	});

	it('treats a bfcached pagehide like a freeze (H2)', async () => {
		const a = makeTab({ slowStop: true });
		assert.equal(await a.lock.acquire(), true);

		a.life.fire('pagehide', { persisted: true });

		assert.equal(a.lock.held, false);
		assert.equal(a.calls.abandon, 1);
		assert.equal(a.calls.stop, 0);
	});

	it('stands down when its lock is stolen, and says so (H4)', async () => {
		const a = makeTab();
		const b = makeTab();
		assert.equal(await a.lock.acquire(), true);

		assert.equal(await b.lock.acquire({ steal: true }), true);
		await until(() => a.calls.abandon > 0);

		// The AbortError the platform sends the victim IS the notification:
		// acting on it drops the worker, so the thief is the only leader.
		assert.equal(a.lock.held, false);
		assert.equal(a.calls.abandon, 1);
		assert.equal(a.calls.stolen, 1);
		assert.equal(b.lock.held, true);
	});

	it('unhooks its lifecycle listeners when it stands down', async () => {
		const a = makeTab();
		assert.equal(await a.lock.acquire(), true);
		assert.equal(a.life.count('unload'), 0, 'Chrome forbids unload; pagehide/freeze stand down');
		a.life.fire('freeze');
		await tick();

		assert.equal(a.life.count('freeze'), 0);
		assert.equal(a.life.count('pagehide'), 0);
		assert.equal(a.life.count('unload'), 0);

		// Re-electing the same tab must not leave two sets of handlers behind.
		assert.equal(await a.lock.acquire(), true);
		assert.equal(a.life.count('freeze'), 1);
	});

	it('does not keep a lock it cannot serve', async () => {
		const a = makeTab();
		const b = makeTab();
		a.startOk(false);

		assert.equal(await a.lock.acquire(), false);
		assert.equal(a.lock.held, false);

		// The lock went straight back, so a tab that can serve gets it.
		assert.equal(await b.lock.acquire(), true);
		assert.equal(b.lock.held, true);
	});

	it('release() gives leadership back without tearing anything down (H6)', async () => {
		const a = makeTab();
		const b = makeTab();
		assert.equal(await a.lock.acquire(), true);

		a.lock.release();
		assert.equal(a.lock.held, false);
		assert.equal(a.calls.stop, 0);
		assert.equal(a.calls.abandon, 0);

		await until(() => !(lockEnv.held.get(NAME) ?? false));
		assert.equal(await b.lock.acquire(), true);
	});

	it('assumes sole ownership where Web Locks does not exist', async () => {
		const life = createFakeLifecycle();
		let started = 0;
		const lock = createCatalogLock({
			name: NAME,
			locks: null,
			lifecycle: life.target,
			start: async () => {
				started += 1;
				return true;
			},
			stop: async () => {},
			abandon: () => {}
		});
		assert.equal(await lock.acquire(), true);
		assert.equal(started, 1);
	});
});
