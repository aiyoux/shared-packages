import type { LiveBusMsg } from './live.ts';
import {
  normalizeLiveThing,
  rowToUpsertMsg,
  deleteMsgForId,
  batchRowsToMsgs
} from './changefeed-convert.ts';

/**
 * Changefeed orchestration — the apply/catch-up logic for a single `changes`
 * row, with all IO injected so it is unit-testable without a websocket.
 *
 * See the LIVE SYNC ARCHITECTURE note at the top of surrealdb-live.ts. The
 * contract:
 *  - `payload.after` is the source of truth when present (zero follow-up
 *    queries — a wave of subscribers does not cause a query storm).
 *  - When it is absent (server omitted it for a complex change, the TTL job
 *    stripped it, or it is a batch with no embedded payload) we fall back to
 *    re-fetching by `record_id` / `batch_*_ids`.
 *  - Own writes are re-applied idempotently — there is NO self-echo
 *    suppression here. Do not add op-id tracking.
 */
export interface ChangefeedDispatchDeps {
  /** `SELECT * FROM [ids]` — returns the matched rows (already parsed). */
  selectByIds: (ids: string[]) => Promise<unknown[]>;
  /** `fn::sync_pull($since, $limit)` — returns the already-parsed result. */
  syncPull: (
    since: string | undefined,
    limit: number
  ) => Promise<{ changes: unknown[]; new_cursor?: unknown; oldest_cursor?: unknown }>;
  /** Deliver one converted bus message to the cache/fan-out. */
  emit: (msg: LiveBusMsg) => void;
  /** Persist the changefeed high-water mark (debounced by the caller). */
  onCursorAdvance?: (cursorId: string) => void;
  /** Abort the catch-up loop early (connection torn down / unauthenticated). */
  isStopped?: () => boolean;
}

const SYNC_PULL_PAGE = 500;
const MAX_CATCHUP_PAGES = 2000;

export function createChangefeedDispatcher(deps: ChangefeedDispatchDeps) {
  /** Apply one `changes` row (live OR catch-up — identical handling). */
  async function dispatchChangeRow(changeRow: Record<string, any>): Promise<void> {
    const action = typeof changeRow.action === 'string' ? changeRow.action.toUpperCase() : '';
    const payload = (changeRow.payload && typeof changeRow.payload === 'object')
      ? (changeRow.payload as Record<string, any>)
      : undefined;
    const after = payload?.after && typeof payload.after === 'object'
      ? payload.after as Record<string, any>
      : null;
    const messages: LiveBusMsg[] = [];

    switch (action) {
      case 'CREATE':
      case 'UPDATE': {
        if (after) {
          const msg = rowToUpsertMsg(after);
          if (msg) messages.push(msg);
        } else {
          const rid = normalizeLiveThing(changeRow.record_id);
          if (rid) {
            const rows = await deps.selectByIds([rid]);
            const row = rows[0];
            if (row && typeof row === 'object') {
              const msg = rowToUpsertMsg(row as Record<string, any>);
              if (msg) messages.push(msg);
            }
          }
        }
        break;
      }
      case 'DELETE': {
        const rid = normalizeLiveThing(changeRow.record_id)
          ?? normalizeLiveThing(payload?.before?.id);
        const msg = deleteMsgForId(rid);
        if (msg) messages.push(msg);
        break;
      }
      case 'BATCH_CLONE':
      case 'BATCH_SYNC_PUSH':
      case 'BATCH_CREATE': {
        // Embedded payload form: { records:[...], edges:[...], groups:[...] }.
        const embedded = after && (Array.isArray(after.records) || Array.isArray(after.edges) || Array.isArray(after.groups))
          ? [
              ...(Array.isArray(after.records) ? after.records : []),
              ...(Array.isArray(after.edges) ? after.edges : []),
              ...(Array.isArray(after.groups) ? after.groups : [])
            ]
          : null;
        if (embedded) {
          messages.push(...batchRowsToMsgs(embedded));
        } else {
          const ids = [
            ...((changeRow.batch_record_ids ?? []) as unknown[]),
            ...((changeRow.batch_edge_ids ?? []) as unknown[]),
            ...((changeRow.batch_group_ids ?? []) as unknown[]),
            ...((changeRow.batch_ids ?? []) as unknown[])
          ].map((t) => normalizeLiveThing(t)).filter((s): s is string => !!s);
          if (ids.length > 0) {
            messages.push(...batchRowsToMsgs(await deps.selectByIds(ids)));
          }
        }
        break;
      }
      case 'BATCH_DELETE': {
        const ids = ((changeRow.batch_ids ?? []) as unknown[])
          .map((t) => normalizeLiveThing(t))
          .filter((s): s is string => !!s);
        const recordIds = ids.filter((id) => id.startsWith('records:'));
        const edgeIds = ids.filter((id) => id.startsWith('graph_child_of:') || id.startsWith('groups:'));
        const appliesIds = ids.filter((id) => id.startsWith('appliesto:'));
        if (recordIds.length > 0) messages.push({ type: 'RecordBatchDelete', ids: recordIds });
        if (edgeIds.length > 0) messages.push({ type: 'GraphChildBatchDelete', edgeIds });
        // No `AppliesBatchDelete` bus message — fan out as singular deletes so
        // batch deletions don't silently leak `appliesto:` edges into the cache.
        for (const edgeId of appliesIds) messages.push({ type: 'AppliesDelete', edgeId });
        break;
      }
      default:
        break;
    }

    for (const m of messages) deps.emit(m);

    const cursor = normalizeLiveThing(changeRow.cursor_id)
      ?? (typeof changeRow.cursor_id === 'string' ? changeRow.cursor_id : undefined);
    if (cursor) deps.onCursorAdvance?.(cursor);
  }

  /**
   * Cursor-based gap recovery. Replays only the `changes` entries newer than
   * `since` (paged), applying each through the SAME dispatchChangeRow pipeline
   * as the live stream — so a payload-less (TTL-stripped) entry transparently
   * falls back to an id re-fetch. Returns the final cursor to persist.
   *
   * Throws if the FIRST page reveals `since` predates the server's retention
   * floor (`oldest_cursor` — see fn::sync_pull / fn::purge_old_changes): the
   * entries between `since` and the floor were already purged, so a "clean"
   * paged replay from here would silently skip a gap instead of catching up.
   * The caller (changefeed-catchup.ts) already falls back to a full resync on
   * ANY thrown error, so this reuses that existing recovery path rather than
   * introducing a second control-flow shape.
   */
  async function runCatchup(since: string | undefined): Promise<string | undefined> {
    let cursor = since;
    for (let page = 0; page < MAX_CATCHUP_PAGES; page++) {
      if (deps.isStopped?.()) break;
      const { changes, new_cursor, oldest_cursor } = await deps.syncPull(cursor, SYNC_PULL_PAGE);

      if (page === 0 && cursor !== undefined) {
        const oldest = normalizeLiveThing(oldest_cursor)
          ?? (typeof oldest_cursor === 'string' ? oldest_cursor : undefined);
        if (oldest && cursor < oldest) {
          throw new Error(
            `changefeed gap: cursor ${cursor} predates the retention floor (${oldest}); entries were purged before this device could catch up`
          );
        }
      }

      const rows = Array.isArray(changes) ? changes : [];
      if (rows.length === 0) break;
      for (const row of rows) {
        if (row && typeof row === 'object') {
          await dispatchChangeRow(row as Record<string, any>);
        }
      }
      const next = normalizeLiveThing(new_cursor)
        ?? (typeof new_cursor === 'string' ? new_cursor : undefined);
      if (!next || next === cursor) break;
      cursor = next;
      if (rows.length < SYNC_PULL_PAGE) break; // last (partial) page drained
    }
    return cursor;
  }

  return { dispatchChangeRow, runCatchup };
}
