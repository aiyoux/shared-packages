import { beforeAll, describe, expect, it } from 'vitest';

// `leader.svelte.ts` captures `const browser = typeof window !== 'undefined'`
// at module-eval time, so the browser globals + navigator.locks polyfill must
// be installed BEFORE the dynamic import below. The runtime's pause/resume
// delegate to `release()` / `resumeAcquire()` on this leader, so its
// release-and-stay-released + re-arm semantics are the core new logic under
// test here.

const lockHolders = new Map<string, AbortSignal>();

function installBrowserGlobals(): void {
  // Node 20+ exposes `globalThis.navigator` as a read-only getter, so install
  // `locks` onto the existing navigator object rather than reassigning it.
  const locks = {
    request(name: string, opts: { signal: AbortSignal }, cb: (lock: unknown) => Promise<void> | void): Promise<void> {
      const signal = opts?.signal;
      if (signal?.aborted) return Promise.resolve();
      // Single-tab polyfill: grant immediately; release on abort. Real
      // multi-tab contention isn't under test here — only the release/re-arm
      // state machine of createLeaderElection.
      lockHolders.set(name, signal);
      try {
        cb(name);
      } catch {
        // Swallow callback errors — not under test.
      }
      signal?.addEventListener('abort', () => {
        if (lockHolders.get(name) === signal) lockHolders.delete(name);
      });
      return Promise.resolve();
    }
  };
  const existingNavigator = (globalThis as { navigator?: Record<string, unknown> }).navigator;
  if (existingNavigator) {
    Object.defineProperty(existingNavigator, 'locks', { value: locks, configurable: true, writable: true });
  } else {
    (globalThis as { navigator: Record<string, unknown> }).navigator = { locks };
  }
  (globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  if (typeof (globalThis as { crypto?: { randomUUID?: unknown } }).crypto?.randomUUID !== 'function') {
    (globalThis as { crypto: { randomUUID: () => string } }).crypto = {
      randomUUID: () => Math.random().toString(36).slice(2)
    };
  }
}

installBrowserGlobals();

let createLeaderElection: typeof import('./leader.svelte.ts')['createLeaderElection'];

beforeAll(async () => {
  ({ createLeaderElection } = await import('./leader.svelte.ts'));
});

describe('createLeaderElection release / resumeAcquire (active/warm pairing)', () => {
  it('acquires leadership on creation', () => {
    const leader = createLeaderElection('test-acquire');
    // The polyfill grants synchronously, so isLeader flips true immediately.
    expect(leader.isLeader).toBe(true);
    expect(leader.leaderSessionId).toBeGreaterThan(0);
    leader.destroy();
  });

  it('release() drops leadership and stays out (does not rejoin)', () => {
    const leader = createLeaderElection('test-release');
    expect(leader.isLeader).toBe(true);
    leader.release();
    expect(leader.isLeader).toBe(false);
    // Stays released — no re-acquisition.
    expect(leader.isLeader).toBe(false);
    leader.destroy();
  });

  it('resumeAcquire() re-arms the lock after release() and re-acquires', () => {
    const leader = createLeaderElection('test-resume');
    expect(leader.isLeader).toBe(true);
    leader.release();
    expect(leader.isLeader).toBe(false);

    leader.resumeAcquire();
    expect(leader.isLeader).toBe(true);
    // leaderSessionId incremented on each (re)acquisition.
    expect(leader.leaderSessionId).toBeGreaterThanOrEqual(2);
    leader.destroy();
  });

  it('resumeAcquire() is a no-op while already holding (not aborted)', () => {
    const leader = createLeaderElection('test-resume-holding');
    expect(leader.isLeader).toBe(true);
    const sessionIdBefore = leader.leaderSessionId;
    leader.resumeAcquire(); // still holding — no re-acquire
    expect(leader.isLeader).toBe(true);
    expect(leader.leaderSessionId).toBe(sessionIdBefore);
    leader.destroy();
  });

  it('double release() is idempotent', () => {
    const leader = createLeaderElection('test-double-release');
    leader.release();
    expect(leader.isLeader).toBe(false);
    leader.release(); // no-op, no throw
    expect(leader.isLeader).toBe(false);
    leader.destroy();
  });

  it('resumeAcquire() after destroy() is a no-op', () => {
    const leader = createLeaderElection('test-destroy');
    leader.release();
    leader.destroy();
    expect(() => leader.resumeAcquire()).not.toThrow();
    expect(leader.isLeader).toBe(false);
  });

  it('onChange fires on release (follower) and on resumeAcquire (leader)', () => {
    const leader = createLeaderElection('test-onchange');
    const transitions: boolean[] = [];
    leader.onChange(() => transitions.push(leader.isLeader));
    // Already leader at registration; release fires the follower transition.
    leader.release();
    leader.resumeAcquire();
    expect(transitions).toEqual([false, true]);
    leader.destroy();
  });
});