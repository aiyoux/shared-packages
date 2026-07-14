import { describe, expect, it, vi } from 'vitest';
import { createChangefeedCatchup, type ChangefeedCatchupDeps } from './changefeed-catchup.ts';

function harness(overrides: Partial<ChangefeedCatchupDeps> = {}) {
  const calls: string[] = [];
  const deps: ChangefeedCatchupDeps = {
    loadPersistedCursor: vi.fn(async () => undefined),
    persistCursor: vi.fn(async (c: string) => { calls.push(`persist:${c}`); }),
    clearPersistedCursor: vi.fn(async () => { calls.push('clearCursor'); }),
    seedCursor: vi.fn(async () => 'seed-cursor'),
    runCatchup: vi.fn(async (s: string) => `${s}+1`),
    resync: vi.fn(async () => { calls.push('resync'); }),
    markCaughtUp: vi.fn(async () => { calls.push('markCaughtUp'); }),
    sweepGhosts: vi.fn(async () => { calls.push('sweepGhosts'); }),
    onWarn: vi.fn(),
    ...overrides
  };
  return { ...createChangefeedCatchup(deps), deps, calls };
}

describe('runChangefeedCatchup — cold start (no persisted cursor)', () => {
  it('full resyncs, seeds the cursor, persists it, marks caught up — no replay', async () => {
    const h = harness();
    await h.runChangefeedCatchup();
    expect(h.deps.resync).toHaveBeenCalledOnce();
    expect(h.deps.seedCursor).toHaveBeenCalledOnce();
    expect(h.deps.persistCursor).toHaveBeenCalledWith('seed-cursor');
    expect(h.deps.runCatchup).not.toHaveBeenCalled();
    expect(h.deps.markCaughtUp).toHaveBeenCalledOnce();
    // resync must happen before the seed is persisted.
    expect(h.calls).toEqual(['resync', 'persist:seed-cursor', 'markCaughtUp']);
    // Ghost sweep is a fallback-only step — a cold start has no prior cursor
    // to have gone stale, so there's nothing to sweep for.
    expect(h.deps.sweepGhosts).not.toHaveBeenCalled();
  });

  it('tolerates a seed failure (non-fatal): warns, still marks caught up, no persist', async () => {
    const h = harness({ seedCursor: vi.fn(async () => { throw new Error('boom'); }) });
    await h.runChangefeedCatchup();
    expect(h.deps.resync).toHaveBeenCalledOnce();
    expect(h.deps.onWarn).toHaveBeenCalled();
    expect(h.deps.persistCursor).not.toHaveBeenCalled();
    expect(h.deps.markCaughtUp).toHaveBeenCalledOnce();
  });

  it('no seed available → resync + markCaughtUp, nothing persisted', async () => {
    const h = harness({ seedCursor: vi.fn(async () => undefined) });
    await h.runChangefeedCatchup();
    expect(h.deps.persistCursor).not.toHaveBeenCalled();
    expect(h.deps.markCaughtUp).toHaveBeenCalledOnce();
  });
});

describe('runChangefeedCatchup — warm reconnect (cursor present)', () => {
  it('precise replay; advanced cursor persisted; no full resync', async () => {
    const h = harness({
      loadPersistedCursor: vi.fn(async () => 'cur-1'),
      runCatchup: vi.fn(async () => 'cur-2')
    });
    await h.runChangefeedCatchup();
    expect(h.deps.runCatchup).toHaveBeenCalledWith('cur-1');
    expect(h.deps.persistCursor).toHaveBeenCalledWith('cur-2');
    expect(h.deps.resync).not.toHaveBeenCalled();
    expect(h.deps.seedCursor).not.toHaveBeenCalled();
    expect(h.deps.markCaughtUp).toHaveBeenCalledOnce();
  });

  it('cursor unchanged → no persist but still marks caught up', async () => {
    const h = harness({
      loadPersistedCursor: vi.fn(async () => 'cur-1'),
      runCatchup: vi.fn(async () => 'cur-1')
    });
    await h.runChangefeedCatchup();
    expect(h.deps.persistCursor).not.toHaveBeenCalled();
    expect(h.deps.markCaughtUp).toHaveBeenCalledOnce();
  });

  it('runCatchup returns undefined → no persist, marks caught up', async () => {
    const h = harness({
      loadPersistedCursor: vi.fn(async () => 'cur-1'),
      runCatchup: vi.fn(async () => undefined)
    });
    await h.runChangefeedCatchup();
    expect(h.deps.persistCursor).not.toHaveBeenCalled();
    expect(h.deps.markCaughtUp).toHaveBeenCalledOnce();
  });

  it('replay failure clears the poisoned cursor, full-resyncs, re-seeds, and marks caught up', async () => {
    const h = harness({
      loadPersistedCursor: vi.fn(async () => 'cur-1'),
      runCatchup: vi.fn(async () => { throw new Error('pull failed'); })
    });
    await h.runChangefeedCatchup();
    expect(h.deps.onWarn).toHaveBeenCalled();
    expect(h.deps.clearPersistedCursor).toHaveBeenCalledOnce();
    expect(h.deps.resync).toHaveBeenCalledOnce();
    // After the fallback resync the cursor is re-seeded to the latest entry
    // so the next reconnect doesn't re-enter the broken window.
    expect(h.deps.seedCursor).toHaveBeenCalledOnce();
    expect(h.deps.persistCursor).toHaveBeenCalledWith('seed-cursor');
    expect(h.deps.markCaughtUp).toHaveBeenCalledOnce();
    // A fallback resync (unlike cold start) DOES run the ghost sweep — the
    // coarse resync snapshot never evicts, so a genuine delete that happened
    // during the gap would otherwise linger forever.
    expect(h.deps.sweepGhosts).toHaveBeenCalledOnce();
    // Order matters: clear before resync; sweep after resync, before re-seed; mark caught up last.
    expect(h.calls).toEqual(['clearCursor', 'resync', 'sweepGhosts', 'persist:seed-cursor', 'markCaughtUp']);
  });

  it('a sweepGhosts failure is non-fatal: warns, still re-seeds and marks caught up', async () => {
    const h = harness({
      loadPersistedCursor: vi.fn(async () => 'cur-1'),
      runCatchup: vi.fn(async () => { throw new Error('pull failed'); }),
      sweepGhosts: vi.fn(async () => { throw new Error('sweep boom'); })
    });
    await h.runChangefeedCatchup();
    expect(h.deps.onWarn).toHaveBeenCalledWith(expect.stringContaining('ghost'), expect.any(Error));
    expect(h.deps.seedCursor).toHaveBeenCalledOnce();
    expect(h.deps.persistCursor).toHaveBeenCalledWith('seed-cursor');
    expect(h.deps.markCaughtUp).toHaveBeenCalledOnce();
  });

  it('sweepGhosts is optional — omitting it is safe', async () => {
    const h = harness({
      loadPersistedCursor: vi.fn(async () => 'cur-1'),
      runCatchup: vi.fn(async () => { throw new Error('pull failed'); }),
      sweepGhosts: undefined
    });
    await expect(h.runChangefeedCatchup()).resolves.toBeUndefined();
    expect(h.deps.markCaughtUp).toHaveBeenCalledOnce();
  });
});
