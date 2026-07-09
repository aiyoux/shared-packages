import type { CacheItem, ChildEdge, Op, AdditionalWithId } from '../cache/types.ts';
import type { LogLevel } from './logger.ts';
import { createLogger } from './logger.ts';
import { emitSyncTrace } from './trace.ts';

export const LIVE_BROADCAST_CHANNEL_PREFIX = 'db-live';

/**
 * LiveBusMsg defines the schema for multi-tab BroadcastChannel communication.
 * Message Directionality Rules:
 *   - Shared (Leader <-> Follower): `SyncWake`
 *   - Leader-Only Dispatch (Leader -> Follower): Cache Mutations (`RecordUpsert`, `RecordDelete`, `GraphChildUpsert`, etc)
 *   - Follower-Only Dispatch (Follower -> Leader): `RpcRequest` (asking leader to perform async DB fetch)
 *   - Leader-Only Dispatch (Leader -> Follower): `RpcResponse` (sending fetch result to origin follower)
 */
export type LiveBusMsg =
  | { type: 'RecordUpsert'; core: CacheItem }
  | { type: 'RecordDelete'; id: string }
  | { type: 'RecordBatchUpsert'; cores: CacheItem[] }
  | { type: 'RecordBatchDelete'; ids: string[] }
  | { type: 'GraphChildUpsert'; edge: ChildEdge }
  | { type: 'GraphChildDelete'; edgeId: string }
  | { type: 'GraphChildBatchUpsert'; edges: ChildEdge[] }
  | { type: 'GraphChildBatchDelete'; edgeIds: string[] }
  | { type: 'GraphChildModuleDataPatch'; edgeId: string; moduleData: Record<string, unknown> }
  | { type: 'AppliesUpsert'; edgeId: string; srcId: string; dstId: string; moduleData?: Record<string, unknown> }
  | { type: 'AppliesDelete'; edgeId: string }
  | { type: 'ChildMove'; childId: string; oldParentId: string; newParentId: string; newIndex: number }
  | { type: 'TempRecordCreate'; tempId: string; text: string; isHeader?: boolean; customColor?: number; parentId: string; insertIndex: number }
  | { type: 'TempIdRemap'; tempId: string; realId: string }
  | { type: 'RecordPatchText'; id: string; text: string }
  | { type: 'RecordPatchColor'; id: string; color: number }
  | { type: 'RecordPatchHeader'; id: string; isHeader: boolean }
  | { type: 'RecordPatchModuleSettings'; id: string; moduleSettings: Record<string, unknown> }
  | {
      type: 'RecordPatchAdditionals';
      id: string;
      /** merge=true: per-id upserts; merge absent: legacy full-array replace. */
      additionals: AdditionalWithId[];
      /** Ids to delete (merge mode) — omission never deletes. */
      removedIds?: string[];
      merge?: boolean;
    }
  | { type: 'RecordSyncStatus'; id: string; status: string; error?: string }
  /**
   * Mirror a sync-engine Op lifecycle change to other tabs. The reactive ops
   * store is per-tab, so a follower that queued an op otherwise may not see
   * the leader's status transitions.
   */
  | { type: 'OpUpsert'; op: Op }
  | { type: 'OpRemove'; id: string }
  | { type: 'SyncWake' }
  /**
   * A foreground follower asking the current (likely backgrounded) leader to
   * hand over leadership so the active tab isn't starved by background-tab
   * timer throttling. Handled only by a hidden leader. Immediate (un-batched)
   * so a throttled leader processes it without waiting on a timer/raf.
   */
  | { type: 'RequestLeadership' }
  | { type: 'RpcRequest'; requestId: string; call: LeaderRpcCall }
  | { type: 'RpcResponse'; requestId: string; ok: boolean; payload?: unknown };

export type LeaderRpcCall =
  | { type: 'FetchRecords'; scopes: string[] }
  | {
      type: 'FetchRecordsByDateRange';
      scopes: string[];
      only_status: boolean;
      year: number; month: number; day: number;
      eyear: number; emonth: number; eday: number;
      /**
       * Record roots whose key-parent tree descendants should be excluded from
       * date fetches. This is tree-only and intentionally does not follow
       * grouping edges.
       */
      excludedTreeScopes?: string[];
      /** Pre-built SurQL fragment from the global scope filter, if any. */
      scopeFragment?: { preamble: string[]; whereExpr: string; vars: Record<string, unknown> };
    }
  | { type: 'FetchEdgesByScopes'; scopes: string[] }
  | { type: 'FetchAppliesByScopes'; scopes: string[] }
  | { type: 'FetchChildren'; parentId: string }
  | {
      type: 'FetchRecordGraph';
      id: string;
      includeParents?: boolean;
      includeChildren?: boolean;
      recursiveChildren?: boolean;
      includeGrouping?: boolean;
      includeConnections?: boolean;
    }
  | {
      type: 'FetchRecordGraphs';
      ids: string[];
      includeParents?: boolean;
      includeChildren?: boolean;
      recursiveChildren?: boolean;
      includeGrouping?: boolean;
      includeConnections?: boolean;
    }
  | { type: 'FetchVwtData'; templateId: string; limit?: number; offset?: number }
  | { type: 'FetchPlanningTemplatesRoot' }
  | { type: 'FetchTemplateClones'; templateId: string; limit?: number; offset?: number }
  | {
      /**
       * Server-side tree clone via fn::clone_from_source_array. `rootId` is the
       * template/container record; its key-parent children are cloned (the
       * container itself is NOT cloned), honoring per-edge clone_setting
       * (default / link_to_common_clone / link_to_original). `anchor` is the
       * ISO datetime used to resolve relative date offsets on clones.
       */
      type: 'CloneTemplateChildren';
      rootId: string;
      /** Exec scope the clones should join as group members (templates live in
       *  a separate library, so source groupings alone won't surface them). */
      targetScopeId?: string;
      anchor?: string;
      /**
       * When true, clone `rootId` ITSELF (and its whole subtree) rather than
       * just its children. Default false = children-only (the template-apply
       * semantic, container root is not cloned). Used by the /records clone
       * button's "include top parent" toggle.
       */
      includeRoot?: boolean;
      /**
       * Force every graph_child_of edge into one clone mode for the whole
       * operation instead of honouring each edge's stored clone_setting.
       * Used by the /records clone button's mode selector. Omitted = per-edge
       * clone_setting (the normal template-apply behaviour).
       */
      cloneSettingOverride?: 'default' | 'link_to_common_clone' | 'link_to_original';
    }
  | { type: 'Ping' };

export interface LiveBusEnvelope {
  scope: string;
  sender: string;
  seq?: number;
  msg: LiveBusMsg;
}

export interface RpcCallOptions {
  timeoutMs?: number;
  /**
   * Snapshot of the caller's view of the current leader session id at request time.
   * If the leader changes between request and response, the bus will reject the
   * pending request via rejectPendingRpcs() so the caller can retry.
   */
  leaderSessionId?: number;
}

export function scoped_channel_name(scope: string): string {
  return `${LIVE_BROADCAST_CHANNEL_PREFIX}:${scope}`;
}

export function createLiveBus(scope: string, senderId: string, options?: { logLevel?: LogLevel }) {
  const channelName = scoped_channel_name(scope);
  const storageChannelKey = `${channelName}:storage`;
  const logger = createLogger(`livebus:${scope}:${senderId}`, options?.logLevel ?? 'error');
  let channel: BroadcastChannel | null = null;
  let destroyed = false;

  // Per-instance state (not module-level) so multiple buses don't interfere
  let pendingMsgs: LiveBusEnvelope[] = [];
  let rafScheduled = false;
  let timeoutScheduled: ReturnType<typeof setTimeout> | null = null;
  let handlers: Array<(msg: LiveBusMsg, sender: string) => void> = [];

  // RPC tracking
  let rpcNextId = Date.now();
  const pendingRequests = new Map<string, {
    resolve: (res: any) => void;
    reject: (err: any) => void;
    timeout: ReturnType<typeof setTimeout>;
    leaderSessionId?: number;
  }>();

  // Sequence tracking
  let outSeq = 1;
  const expectedSeqs = new Map<string, number>();
  const outOfOrderBuffers = new Map<string, Map<number, LiveBusEnvelope>>();

  logger.info(`initialized live bus channel=${channelName} broadcast=${typeof BroadcastChannel !== 'undefined'} storage=${typeof window !== 'undefined'}`);
  emitSyncTrace(`livebus:${scope}`, 'init', {
    senderId,
    channelName,
    broadcastAvailable: typeof BroadcastChannel !== 'undefined',
    storageAvailable: typeof window !== 'undefined'
  });

  function publishEnvelope(envelope: LiveBusEnvelope) {
    channel?.postMessage(envelope);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(storageChannelKey, JSON.stringify(envelope));
      } catch (error) {
        logger.warn('failed to persist storage bus message', error);
      }
    }
  }

  function isImmediateMessage(msg: LiveBusMsg): boolean {
    return (
      msg.type === 'SyncWake' ||
      msg.type === 'RequestLeadership' ||
      msg.type === 'RpcRequest' ||
      msg.type === 'RpcResponse'
    );
  }

  function deliver(envelope: LiveBusEnvelope) {
    if (envelope.msg.type === 'RpcResponse' && pendingRequests.has(envelope.msg.requestId)) {
      const p = pendingRequests.get(envelope.msg.requestId)!;
      clearTimeout(p.timeout);
      pendingRequests.delete(envelope.msg.requestId);
      if (envelope.msg.ok) p.resolve(envelope.msg.payload);
      else p.reject(new Error((envelope.msg.payload as string) || 'RPC Failed'));
      return;
    }

    for (const handler of handlers) {
      handler(envelope.msg, envelope.sender);
    }
  }

  function flushBuffered(sender: string, expected: number): number {
    const buffer = outOfOrderBuffers.get(sender);
    if (buffer) {
      while (buffer.has(expected)) {
        const buffered = buffer.get(expected)!;
        buffer.delete(expected);
        deliver(buffered);
        expected++;
      }
      if (buffer.size === 0) {
        outOfOrderBuffers.delete(sender);
      }
    }
    return expected;
  }

  function processSequence(envelope: LiveBusEnvelope) {
    const sender = envelope.sender;
    const seq = envelope.seq;

    // Fast-path immediate messages or gracefully handle missing seq
    if (seq === undefined || isImmediateMessage(envelope.msg)) {
      deliver(envelope);
      return;
    }

    let expected = expectedSeqs.get(sender);

    if (expected === undefined) {
      // First time we hear from this sender's mutations, accept their starting sequence
      expectedSeqs.set(sender, seq + 1);
      deliver(envelope);
      return;
    }

    if (seq < expected) {
      // Stale or duplicate message, discard
      return;
    }

    if (seq > expected) {
      // Out of order message, buffer it
      let buffer = outOfOrderBuffers.get(sender);
      if (!buffer) {
        buffer = new Map();
        outOfOrderBuffers.set(sender, buffer);
      }
      buffer.set(seq, envelope);
      return;
    }

    // Exact expected message
    deliver(envelope);
    expectedSeqs.set(sender, flushBuffered(sender, expected + 1));
  }

  function enqueueEnvelope(envelope: LiveBusEnvelope, source: 'broadcast-channel' | 'storage') {
    if (envelope.sender === senderId) return;

    if (isImmediateMessage(envelope.msg)) {
      logger.debug(`received immediate bus message type=${envelope.msg.type} sender=${envelope.sender} via=${source}`);
      emitSyncTrace(`livebus:${scope}`, 'receive-immediate', {
        senderId,
        sender: envelope.sender,
        type: envelope.msg.type,
        source
      });
      processSequence(envelope);
      return;
    }

    pendingMsgs.push(envelope);
    logger.debug(`queued bus mutation type=${envelope.msg.type} sender=${envelope.sender} pending=${pendingMsgs.length} via=${source}`);
    emitSyncTrace(`livebus:${scope}`, 'queue-mutation', {
      senderId,
      sender: envelope.sender,
      type: envelope.msg.type,
      pending: pendingMsgs.length,
      source
    });
    scheduleProcess();
  }

  function processPending() {
    rafScheduled = false;
    if (timeoutScheduled) {
      clearTimeout(timeoutScheduled);
      timeoutScheduled = null;
    }
    const msgs = pendingMsgs;
    pendingMsgs = [];
    logger.debug(`processing queued bus mutations count=${msgs.length}`);
    emitSyncTrace(`livebus:${scope}`, 'process-pending', { senderId, count: msgs.length });
    for (const envelope of msgs) {
      processSequence(envelope);
    }
  }

  function shouldUseAnimationFrame(): boolean {
    if (typeof requestAnimationFrame !== 'function') return false;
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  }

  function scheduleProcess() {
    if (rafScheduled || timeoutScheduled) return;
    if (shouldUseAnimationFrame()) {
      rafScheduled = true;
      logger.debug('scheduled bus mutation flush via requestAnimationFrame');
      emitSyncTrace(`livebus:${scope}`, 'schedule-flush', { senderId, mode: 'raf', pending: pendingMsgs.length });
      requestAnimationFrame(processPending);
      return;
    }

    timeoutScheduled = setTimeout(processPending, 0);
    logger.debug('scheduled bus mutation flush via timeout fallback');
    emitSyncTrace(`livebus:${scope}`, 'schedule-flush', { senderId, mode: 'timeout', pending: pendingMsgs.length });
  }

  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(channelName);
    channel.addEventListener('message', (e: MessageEvent<LiveBusEnvelope>) => {
      enqueueEnvelope(e.data, 'broadcast-channel');
    });
  }

  function handleStorageEvent(event: StorageEvent) {
    if (event.key !== storageChannelKey || !event.newValue) return;
    try {
      enqueueEnvelope(JSON.parse(event.newValue) as LiveBusEnvelope, 'storage');
    } catch (error) {
      logger.warn('failed to parse storage bus message', error);
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', handleStorageEvent);
  }

  return {
    broadcast(msg: LiveBusMsg) {
      if (destroyed || !channel) return;
      const envelope: LiveBusEnvelope = {
        scope,
        sender: senderId,
        seq: isImmediateMessage(msg) ? undefined : outSeq++,
        msg
      };
      logger.debug(`broadcast bus message type=${msg.type} seq=${envelope.seq ?? 'immediate'}`);
      emitSyncTrace(`livebus:${scope}`, 'broadcast', {
        senderId,
        type: msg.type,
        seq: envelope.seq ?? null
      });
      publishEnvelope(envelope);
    },

    onMessage(handler: (msg: LiveBusMsg, sender: string) => void) {
      handlers.push(handler);
      return () => {
        handlers = handlers.filter(h => h !== handler);
      };
    },

    rpc<T = unknown>(call: LeaderRpcCall, optionsOrTimeoutMs: number | RpcCallOptions = 5000): Promise<T> {
      const opts: RpcCallOptions = typeof optionsOrTimeoutMs === 'number'
        ? { timeoutMs: optionsOrTimeoutMs }
        : optionsOrTimeoutMs;
      const timeoutMs = opts.timeoutMs ?? 5000;
      return new Promise((resolve, reject) => {
        if (destroyed || !channel) return reject(new Error('LiveBus destroyed'));
        const requestId = `rpc_${rpcNextId++}_${crypto.randomUUID()}`;

        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error(`RPC Timeout: ${call.type}`));
        }, timeoutMs);

        pendingRequests.set(requestId, {
          resolve,
          reject,
          timeout,
          leaderSessionId: opts.leaderSessionId
        });

        const msg: LiveBusMsg = { type: 'RpcRequest', requestId, call };
        const envelope: LiveBusEnvelope = { scope, sender: senderId, msg };
        logger.debug(`broadcast rpc request type=${call.type} requestId=${requestId}`);
        emitSyncTrace(`livebus:${scope}`, 'rpc-request', {
          senderId,
          requestId,
          type: call.type
        });
        publishEnvelope(envelope);
      });
    },

    /**
     * Reject all in-flight cross-tab RPC requests. Intended for use when the
     * leader changes (or is lost) so that callers waiting on a now-stale leader
     * fail fast and can retry against the new leader instead of waiting out
     * the per-call timeout.
     */
    rejectPendingRpcs(reason: string, opts?: { onlyOlderThanSession?: number }) {
      for (const [requestId, entry] of [...pendingRequests.entries()]) {
        if (
          opts?.onlyOlderThanSession !== undefined &&
          entry.leaderSessionId !== undefined &&
          entry.leaderSessionId >= opts.onlyOlderThanSession
        ) {
          continue;
        }
        clearTimeout(entry.timeout);
        pendingRequests.delete(requestId);
        entry.reject(new Error(reason));
      }
    },

    destroy() {
      destroyed = true;
      if (timeoutScheduled) {
        clearTimeout(timeoutScheduled);
        timeoutScheduled = null;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', handleStorageEvent);
      }
      if (channel) {
        channel.close();
        channel = null;
      }
      handlers = [];
      pendingMsgs = [];
      
      for (const { reject, timeout } of pendingRequests.values()) {
        clearTimeout(timeout);
        reject(new Error('LiveBus destroyed'));
      }
      pendingRequests.clear();
      expectedSeqs.clear();
      outOfOrderBuffers.clear();
    }
  };
}

export type LiveBus = ReturnType<typeof createLiveBus>;
