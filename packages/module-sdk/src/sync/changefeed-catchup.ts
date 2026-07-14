/**
 * Changefeed gap-recovery orchestration, with all IO injected so it is
 * unit-testable without a runtime/socket/IndexedDB.
 *
 * See the LIVE SYNC ARCHITECTURE note at the top of surrealdb-live.ts.
 * Contract:
 *  - Cold start (no persisted cursor) → one full resync for the initial
 *    dataset, then SEED the cursor to the latest changefeed entry so we do
 *    not replay all history. Cursor seeding failure is non-fatal (next live
 *    entry advances it).
 *  - Warm reconnect (cursor present) → precise `fn::sync_pull` replay of only
 *    the missed window via runCatchup; persist the advanced cursor.
 *  - A failed precise replay falls back to the blunt full resync so the cache
 *    still converges (never silently lose data).
 */
export interface ChangefeedCatchupDeps {
  /** In-memory-or-persisted high-water cursor (undefined ⇒ cold start). */
  loadPersistedCursor: () => Promise<string | undefined>;
  /** Persist (and update in-memory) the cursor. */
  persistCursor: (cursor: string) => Promise<void>;
  /** Drop the persisted cursor (recover from a poisoned warm-reconnect). */
  clearPersistedCursor?: () => Promise<void>;
  /** Latest `changes.cursor_id` — used to seed the cursor on cold start. */
  seedCursor: () => Promise<string | undefined>;
  /** Cursor-paged `fn::sync_pull` replay; returns the final cursor. */
  runCatchup: (since: string) => Promise<string | undefined>;
  /** Blunt full-scope resync (cold-start dataset / replay-failure fallback). */
  resync: () => Promise<void>;
  /** Clear the "catch-up required" flag once converged. */
  markCaughtUp: () => Promise<void>;
  /**
   * Targeted eviction of cached records that no longer exist server-side,
   * run ONLY after a fallback resync (not on cold start). The coarse
   * namespace snapshot behind `resync()` deliberately never evicts (it's
   * permission-narrowed under record-auth — see applyRecordSnapshot's note),
   * so a genuine server-side DELETE that happened during a gap (a stale
   * cursor past the retention floor, or any other replay failure) would
   * otherwise leave a ghost record in the cache forever. Optional so callers
   * that don't have a cheap per-id existence check can omit it.
   */
  sweepGhosts?: () => Promise<void>;
  onWarn?: (msg: string, error: unknown) => void;
}

export function createChangefeedCatchup(deps: ChangefeedCatchupDeps) {
  async function runChangefeedCatchup(): Promise<void> {
    const since = await deps.loadPersistedCursor();

    if (!since) {
      // Cold start: full dataset, then seed the cursor past existing history.
      await deps.resync();
      try {
        const seed = await deps.seedCursor();
        if (seed) await deps.persistCursor(seed);
      } catch (e) {
        deps.onWarn?.('failed to seed changefeed cursor after cold-start resync', e);
      }
      await deps.markCaughtUp();
      return;
    }

    try {
      const next = await deps.runCatchup(since);
      if (next && next !== since) await deps.persistCursor(next);
      await deps.markCaughtUp();
    } catch (e) {
      deps.onWarn?.('changefeed catch-up failed; falling back to full resync', e);
      // Drop the poisoned cursor so the next reconnect doesn't re-enter the
      // failing window and spin in fallback. After the full resync converges,
      // re-seed past the latest changefeed entry and mark caught up — mirrors
      // the cold-start path so subsequent live events advance correctly.
      try {
        await deps.clearPersistedCursor?.();
      } catch (clearErr) {
        deps.onWarn?.('failed to clear poisoned changefeed cursor', clearErr);
      }
      await deps.resync();
      try {
        await deps.sweepGhosts?.();
      } catch (sweepErr) {
        deps.onWarn?.('ghost record sweep failed after fallback resync', sweepErr);
      }
      try {
        const seed = await deps.seedCursor();
        if (seed) await deps.persistCursor(seed);
      } catch (seedErr) {
        deps.onWarn?.('failed to seed changefeed cursor after fallback resync', seedErr);
      }
      await deps.markCaughtUp();
    }
  }

  return { runChangefeedCatchup };
}
