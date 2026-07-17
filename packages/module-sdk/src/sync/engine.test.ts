import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncEngine, isRetryableSyncError, isNetworkSyncError } from './engine.ts';

const { persistOpMock, deleteOpMock, updateOpStatusMock, loadPendingOpsMock, loadAllOpsMock } = vi.hoisted(() => ({
  persistOpMock: vi.fn(),
  deleteOpMock: vi.fn(),
  updateOpStatusMock: vi.fn(),
  loadPendingOpsMock: vi.fn(),
  loadAllOpsMock: vi.fn()
}));

vi.mock('../cache/persist', () => ({
  persistOp: persistOpMock,
  deleteOp: deleteOpMock,
  updateOpStatus: updateOpStatusMock,
  getPendingOps: loadPendingOpsMock,
  getAllOps: loadAllOpsMock
}));

function createCacheStub() {
  return {
    remap_id: vi.fn(),
    update_sync_status: vi.fn(),
    // queueOp de-proxies payloads via cache.clonePlain before persist/broadcast.
    // The stub passes plain data through unchanged (test payloads are already
    // plain JS); the real cache does $state.snapshot + structuredClone.
    clonePlain: vi.fn((v: unknown) => v),
    normalizeItem: vi.fn(),
    removeItem: vi.fn(),
    batch_upsert: vi.fn(),
    batch_delete: vi.fn(),
    upsert_graph_child_of_edge: vi.fn(),
    remove_graph_child: vi.fn(),
    upsert_applies_edge: vi.fn(),
    remove_applies_edge: vi.fn(),
    patch_item_text: vi.fn(),
    patch_item_color: vi.fn(),
    patch_item_header: vi.fn(),
    patch_item_module_settings: vi.fn(),
    patch_item_additionals: vi.fn(),
    notify_sync_idle: vi.fn(),
    childrenEdges: {
      get: vi.fn()
    },
    appliesEdges: {
      get: vi.fn()
    }
  };
}

function createBusStub() {
  return {
    onMessage: vi.fn(() => () => {}),
    broadcast: vi.fn(),
    rpc: vi.fn()
  };
}

describe('createSyncEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPendingOpsMock.mockResolvedValue([]);
    loadAllOpsMock.mockResolvedValue([]);
    persistOpMock.mockResolvedValue(undefined);
    deleteOpMock.mockResolvedValue(undefined);
    updateOpStatusMock.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('does not drop ops when Surreal returns a statement-level error inside an HTTP 200', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'ERR', detail: 'permission denied' }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRecord', { id: 'records:1', text: 'hello' });
    await engine.pushOps();

    expect(deleteOpMock).not.toHaveBeenCalled();
    expect(engine.getPendingOps()).toHaveLength(1);
    expect(engine.failureCount).toBe(1);
    expect(cache.update_sync_status).toHaveBeenCalledWith('records:1', 'pending');
    expect(persistOpMock).toHaveBeenLastCalledWith(
      'test-sync',
      expect.objectContaining({
        kind: 'UpdateRecord',
        status: 'pending',
        retries: 1
      })
    );
  });

  it('per-op backoff: a failing op does not block a freshly-queued op', async () => {
    // Blast-radius regression guard. The old global failureCount/backoff gate
    // made pushOps() return early for the WHOLE queue once any op failed, so a
    // brand-new write got stranded until the backoff elapsed. With per-op
    // backoff the failing op (now backing off) is skipped while the never-tried
    // op is attempted immediately.
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    // 1st HTTP call (op A) → statement-level error → A fails, starts backing off.
    // Every later call (op B) → success.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([{ status: 'ERR', detail: 'read or write conflict' }])
      } as unknown as Response)
      .mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue([{ status: 'OK', result: null }])
      } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRecord', { id: 'records:A', text: 'a' });
    await engine.pushOps();
    // A failed and is pending again, now within its retry backoff window.
    expect(engine.getPendingOps()).toHaveLength(1);

    engine.queueOp('UpdateRecord', { id: 'records:B', text: 'b' });
    await engine.pushOps();

    // B (retries 0) was eligible and got attempted + accepted; A is still
    // backing off. The old global gate would have skipped this push entirely,
    // leaving BOTH ops pending and B never attempted (length 2).
    const pending = engine.getPendingOps();
    expect(pending).toHaveLength(1);
    expect((pending[0].payload as any).id).toBe('records:A');
    // B reached accept → dropped from the durable queue.
    expect(deleteOpMock).toHaveBeenCalled();
  });

  it('removes the deleted record locally when a DeleteTree op is accepted', async () => {
    // Callers no longer remove optimistically at queue time (so a pending delete
    // can show its indicator and isn't resurrected by a refetch racing server
    // indexing), so the accept is the authoritative local removal.
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: null }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('DeleteTree', { id: 'records:gone' });
    await engine.pushOps();

    expect(cache.removeItem).toHaveBeenCalledWith('records:gone');
    expect(deleteOpMock).toHaveBeenCalled(); // op accepted → dropped from durable queue
    expect(engine.getPendingOps()).toHaveLength(0);
  });

  it('classifies SurrealDB transaction conflicts as retryable', () => {
    expect(
      isRetryableSyncError(
        new Error(
          'SurrealDB statement failure: {"result":"The query was not executed due to a failed transaction. Failed to commit transaction due to a read or write conflict. This transaction can be retried","status":"ERR"}'
        )
      )
    ).toBe(true);
    expect(isRetryableSyncError(new Error('permission denied'))).toBe(false);
  });

  it('keeps retryable transaction conflicts pending beyond the standard retry cap', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-21T00:00:00Z'));

      const cache = createCacheStub();
      const liveBus = createBusStub();
      const fetchMock = vi.mocked(fetch);

      fetchMock.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue([
          {
            status: 'ERR',
            result: 'The query was not executed due to a failed transaction. Failed to commit transaction due to a read or write conflict. This transaction can be retried'
          }
        ])
      } as unknown as Response);

      const engine = createSyncEngine(cache as any, liveBus as any, {
        url: 'http://localhost:8000',
        namespace: 'app',
        storageNamespace: 'test-sync',
        database: 'main',
        token: 'token',
        scopes: []
      });

      engine.queueOp('CreateRecord', {
        id: 'temp:1',
        text: 'optimistic node',
        is_temp: true,
        sync_status: 'pending'
      });

      for (let attempt = 0; attempt < 13; attempt++) {
        await engine.pushOps();
        vi.setSystemTime(Date.now() + 301_000);
      }

      expect(engine.getPendingOps()).toHaveLength(1);
      expect(cache.update_sync_status).toHaveBeenLastCalledWith('temp:1', 'pending');
      expect(persistOpMock).toHaveBeenLastCalledWith(
        'test-sync',
        expect.objectContaining({
          kind: 'CreateRecord',
          status: 'pending',
          retries: 13
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('pushes write ops to /sql as text/plain SurrealQL statements with record casts for ids', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: null }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRecord', {
      id: 'records:1',
      text: 'hello',
      additionals: [{ id: 'a1', type: 'date', date_info: { is_status: false, value: { d: { s: { type: 'ba', v: 1 } } } } }]
    });
    await engine.pushOps();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/sql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'text/plain'
        }),
        body: expect.stringContaining('LET $payload = ')
      })
    );
    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    expect(body).toContain('LET $id = "records:1";');
    expect(body).not.toContain('"t":"date"');
    expect(body).toContain('"type":"date"');
    expect(body).not.toContain('"d":{"date_info"');
    expect(body).toContain('"is":false');
    expect(body).toContain('UPDATE type::record($id) MERGE $payload');
  });

  it('peels additionals out of the MERGE body and routes them through fn::merge_additionals', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: null }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRecord', {
      id: 'records:1',
      additionals: [{ id: 'a1', type: 'pg', prog_type: { ch: 't' } }],
      removed_additional_ids: ['b2']
    });
    await engine.pushOps();

    const body = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body);
    // Merge fn is invoked with the dedicated vars…
    expect(body).toContain('fn::merge_additionals(');
    expect(body).toContain('$incoming_additionals');
    expect(body).toContain('$removed_additional_ids');
    expect(body).toContain('LET $removed_additional_ids = ["b2"];');
    // …and the MERGE body carries NEITHER field (a whole-array MERGE write
    // would clobber the per-id merge).
    const payloadLine = body.split('\n').find((line) => line.startsWith('LET $payload = '));
    expect(payloadLine).toBeDefined();
    expect(payloadLine).not.toContain('"additionals"');
    expect(payloadLine).not.toContain('removed_additional_ids');
    // Queue-time updated_at stamping (edit time, not flush time).
    const incomingLine = body.split('\n').find((line) => line.startsWith('LET $incoming_additionals = '));
    expect(incomingLine).toContain('"updated_at"');
  });

  it('refuses to send server-owned computed_additionals in any record payload', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: null }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRecord', {
      id: 'records:1',
      text: 'hi',
      computed_additionals: [{ id: 'c1', type: 'pg', prog_type: { ch: 't' }, computed: true }]
    });
    await engine.pushOps();

    const body = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body);
    // The MERGE body must not carry the server-owned field (the SQL text
    // legitimately references fn::recompute_computed_additionals).
    const payloadLine = body.split('\n').find((line) => line.startsWith('LET $payload = '));
    expect(payloadLine).toBeDefined();
    expect(payloadLine).not.toContain('computed_additionals');
  });

  it('remaps temp ids ONLY inside module_settings refs objects (not plain module_settings keys)', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    const op = engine.queueOp('UpdateRecord', {
      id: 'records:line',
      module_settings: {
        shopping_module: {
          line_item: {
            // These MUST remap (reserved refs object)…
            refs: { list_id: 'temp:list', source_record_ids: ['temp:src', 'records:keep'] },
            // …this MUST NOT (a plain module_settings key, even though the key
            // name looks reference-y) — a module blob is opaque to the remapper.
            list_id: 'temp:list'
          }
        }
      }
    });

    engine.applyRemote({ type: 'TempIdRemap', tempId: 'temp:list', realId: 'records:real-list' } as any);
    engine.applyRemote({ type: 'TempIdRemap', tempId: 'temp:src', realId: 'records:real-src' } as any);

    const line = (op.payload as any).module_settings.shopping_module.line_item;
    expect(line.refs.list_id).toBe('records:real-list');
    expect(line.refs.source_record_ids).toEqual(['records:real-src', 'records:keep']);
    // The plain (non-refs) key is left untouched — it is module-private data.
    expect(line.list_id).toBe('temp:list');
  });

  it('keeps remapping structural graph keys outside module_settings', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    const op = engine.queueOp('AddChild', { id: 'temp:edge', parent: 'temp:p', child: 'temp:c' });
    engine.applyRemote({ type: 'TempIdRemap', tempId: 'temp:p', realId: 'records:p' } as any);

    expect((op.payload as any).parent).toBe('records:p');
    // untouched sibling still temp
    expect((op.payload as any).child).toBe('temp:c');
  });

  it('keeps DeleteTree scoped to record subtree deletion and uses RemoveChild for graph edges', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: null }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('DeleteTree', { id: 'records:clone-root' });
    await engine.pushOps();

    let body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    expect(body).toContain('LET $id = "records:clone-root";');
    expect(body).toContain('fn::delete_and_children(type::record($id));');
    expect(body).not.toContain('DELETE type::record($id);');

    fetchMock.mockClear();
    engine.queueOp('DeleteTree', { id: 'graph_child_of:edge-1' });
    await engine.pushOps();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(engine.getPendingOps()[0]?.last_error).toContain('DeleteTree requires a records:* id');

    const removeChildEngine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync-remove-child',
      database: 'main',
      token: 'token',
      scopes: []
    });
    removeChildEngine.queueOp('RemoveChild', { id: 'graph_child_of:edge-1' });
    await removeChildEngine.pushOps();

    body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    expect(body).toContain('LET $id = "graph_child_of:edge-1";');
    expect(body).toContain('DELETE type::record($id)');
    expect(body).not.toContain('fn::delete_and_children(type::record($id));');
  });

  it('applies and broadcasts returned record rows after accepted update ops', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const returnedRecord = {
      id: 'records:1',
      text: 'server truth',
      additionals: [{ id: 'pg1', type: 'pg', prog_type: { ch: 't' }, computed: true }]
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: returnedRecord }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRecord', {
      id: 'records:1',
      additionals: [{ id: 'pg1', type: 'pg', prog_type: { ch: 'f' }, computed: false }]
    });
    await engine.pushOps();

    expect(cache.normalizeItem).toHaveBeenCalledWith(expect.objectContaining({
      id: 'records:1',
      text: 'server truth',
      additionals: returnedRecord.additionals,
      sync_status: 'accepted'
    }));
    expect(liveBus.broadcast).toHaveBeenCalledWith({
      type: 'RecordUpsert',
      core: expect.objectContaining({
        id: 'records:1',
        additionals: returnedRecord.additionals,
        sync_status: 'accepted'
      })
    });
  });

  it('normalizes returned record permissions to the cache shape (regression: remove one of two -> both gone)', async () => {
    // The RETURN query carries permissions in the STORED shape { r, u: <record> }
    // (enriched with username/icon by the SQL projection, but field names are r/u).
    // The accept path must route through recordCoreFromRow so the cache gets the
    // normalized { role, user_id, username, user_icon_small } shape the UI expects.
    // Previously the hand-built core cached raw { r, u } permissions, which the
    // calendar editor filtered out (it requires user_id/role strings) -> every
    // save made permissions vanish until the next enriched refetch.
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const returnedRecord = {
      id: 'records:1',
      text: 'server truth',
      permissions: [
        { r: 'editor', u: 'users:abc', username: 'Alice', user_icon_small: 'img:abc' }
      ]
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: returnedRecord }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRecord', { id: 'records:1', text: 'edit' });
    await engine.pushOps();

    expect(cache.normalizeItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'records:1',
        permissions: [{ role: 'editor', user_id: 'users:abc', username: 'Alice', user_icon_small: 'img:abc' }]
      })
    );
  });

  it('clears all permissions when an empty permissions array is sent', async () => {
    // Dropping the array::len($perms) > 0 guard means an empty permissions
    // array is no longer silently no-op'd -- the last permission can now be
    // removed. It writes NONE (not []): the records PERMISSIONS clause
    // treats a stored [] as "deny everyone including the owner", while NONE
    // is the public baseline -- see the write-side comment in engine.ts.
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: [{ id: 'records:1' }] }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRecord', { id: 'records:1', text: 'edit', permissions: [] });
    await engine.pushOps();

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    // Empty array is no longer skipped (the guard no longer no-ops it), but
    // it writes NONE rather than [] to avoid the ACL "deny everyone" trap.
    expect(body).toContain('LET $perms = [];');
    expect(body).toContain('IF array::len($perms) = 0 {');
    expect(body).toContain('UPDATE type::record($id) MERGE { permissions: NONE };');
  });

  it('builds relation writes with parameterized record ids that Surreal accepts in RELATE statements', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: [] }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('AddChild', {
      parent: 'records:parent-1',
      child: 'records:child-1',
      order: 0,
      key_parent: true
    });
    await engine.pushOps();

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    expect(body).toContain('LET $parent = "records:parent-1";');
    expect(body).toContain('LET $child = "records:child-1";');
    expect(body).toContain('SELECT VALUE id FROM graph_child_of');
    expect(body).toContain('WHERE in = $c AND out = $p');
    expect(body).toContain('RELATE $c->graph_child_of->$p CONTENT $payload');
  });

  it('builds tree batch relation writes without dotted record expressions in RELATE paths', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: vi.fn().mockResolvedValue('bad request')
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('CreateTreeBatch', {
      records: [
        { tempId: 'temp:root', content: { text: 'Root' } },
        { tempId: 'temp:child', content: { text: 'Child' } }
      ],
      edges: [
        {
          tempEdgeId: 'graph_child_of:temp-child-root',
          childTempId: 'temp:child',
          parentRef: { kind: 'temp', tempId: 'temp:root' },
          order: 0,
          key_parent: true,
          moduleData: { planner: { role: 'task', schedule: 'own_date' } }
        },
        {
          tempEdgeId: 'graph_child_of:temp-root-real',
          childTempId: 'temp:root',
          parentRef: { kind: 'real', id: 'records:existing-parent' },
          order: 1,
          key_parent: false
        }
      ],
      optimisticTempIds: [],
      optimisticTempEdgeIds: []
    });
    await engine.pushOps();

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    expect(body).toContain('LET $r_0 = (CREATE records CONTENT $rec_0)[0];');
    expect(body).toContain('LET $r_1 = (CREATE records CONTENT $rec_1)[0];');
    expect(body).toContain('LET $r_id_0 = $r_0.id;');
    expect(body).toContain('LET $r_id_1 = $r_1.id;');
    expect(body).toContain('LET $edge_1_parent_id = type::record($edge_1_parent);');
    expect(body).toContain('RELATE $r_id_1->graph_child_of->$r_id_0 CONTENT $edge_0');
    expect(body).toContain('RELATE $r_id_0->graph_child_of->$edge_1_parent_id CONTENT $edge_1');
    expect(body).not.toContain('.id->graph_child_of');
    expect(body).not.toContain('->type::record');
    expect(body).toContain('"module_data":{"planner":{"role":"task","schedule":"own_date"}}');
    // The batch must suppress per-row changefeed and emit ONE consolidated
    // entry (the CreateTreeBatch analogue of fn::clone_from_source_array) —
    // otherwise N CREATE/RELATE rows flood every live subscriber. Vars are
    // inlined as `LET $rec_0 = {...};`, so the record/edge content carries
    // skip_changefeed and the tail emits a single fn::log_batch_clone.
    expect(body).toContain('"skip_changefeed":true');
    expect(body).toContain('fn::log_batch_clone($batch_record_ids, $batch_edge_ids, $batch_group_ids');
    expect(body).toContain('UPDATE $batch_record_ids SET skip_changefeed = NONE;');
  });

  it('batches UpdateRecordsBatch into one suppressed multi-update + single log_batch_clone', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: vi.fn().mockResolvedValue('bad request')
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRecordsBatch', {
      records: [
        { id: 'records:a', additionals: [{ id: 'x', type: 'dt' }] },
        { id: 'records:b', additionals: [{ id: 'y', type: 'dt' }] }
      ]
    });
    await engine.pushOps();

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    // Idempotency guard mirrors buildTreeBatchSql. The SELECT enriches
    // permissions (user_public join) so the returned row matches a fetch.
    expect(body).toContain('LET $existing = (SELECT *, (IF permissions != NONE {');
    expect(body).toContain('AS permissions FROM records WHERE _sync_op_id = $op_id);');
    // Each row updated by record-id target ($var, never an inline literal).
    expect(body).toContain('LET $rt_0 = type::record($rid_0);');
    expect(body).toContain('UPDATE $rt_0 MERGE $u_0;');
    expect(body).toContain('LET $rt_1 = type::record($rid_1);');
    // Per-row changefeed suppressed; ONE consolidated entry at the tail;
    // skip_changefeed cleared via a $var (inline `[literal]` is a parse error).
    expect(body).toContain('"skip_changefeed":true');
    expect(body).toContain('fn::log_batch_clone($batch_record_ids, [], [], $batch_perms);');
    expect(body).toContain('UPDATE $batch_record_ids SET skip_changefeed = NONE;');
    // Exactly one log_batch_clone for the whole batch.
    expect((body as string).match(/fn::log_batch_clone/g)?.length).toBe(1);
  });

  it('fires sync-marker cleanup after accepted UpdateRecordsBatch', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        { status: 'OK', result: { records: [{ id: 'records:a' }], edges: [] } }
      ])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRecordsBatch', {
      records: [{ id: 'records:a', additionals: [] }]
    });
    await engine.pushOps();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cleanupBody = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body;
    expect(cleanupBody).toContain('UPDATE records UNSET _sync_op_id WHERE _sync_op_id IN $op_ids');
    expect(cache.batch_upsert).toHaveBeenCalled();
    expect(liveBus.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RecordBatchUpsert' })
    );
  });

  it('defers relation ops that still reference optimistic temp ids', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('AddChild', {
      parent: 'records:parent-1',
      child: 'temp:child-1',
      order: 0,
      key_parent: true
    });
    await engine.pushOps();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(engine.getPendingOps()).toHaveLength(1);
    expect(persistOpMock).toHaveBeenLastCalledWith(
      'test-sync',
      expect.objectContaining({
        kind: 'AddChild',
        status: 'pending',
        retries: 0,
        payload: expect.objectContaining({
          child: 'temp:child-1'
        })
      })
    );
  });

  it('remaps optimistic ids only after validating the response payload', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: [{ id: 'records:real-1' }] }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('CreateRecord', { id: 'temp:1', text: 'optimistic node', is_temp: true, sync_status: 'pending' });
    await engine.pushOps();

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    // Idempotency guard SELECT enriches permissions (user_public join) so the
    // returned row matches a fetch.
    expect(body).toContain('AS permissions FROM records WHERE _sync_op_id = $op_id LIMIT 1');
    expect(body).toContain('CREATE records CONTENT $payload');

    expect(cache.remap_id).toHaveBeenCalledWith('temp:1', 'records:real-1');
    expect(cache.update_sync_status).toHaveBeenCalledWith('records:real-1', 'accepted');
    expect(liveBus.broadcast).toHaveBeenCalledWith({
      type: 'TempIdRemap',
      tempId: 'temp:1',
      realId: 'records:real-1'
    });
    expect(persistOpMock).toHaveBeenCalledWith(
      'test-sync',
      expect.objectContaining({
        kind: 'CreateRecord',
        status: 'accepted'
      })
    );
    expect(deleteOpMock).toHaveBeenCalledTimes(1);
    expect(engine.getPendingOps()).toHaveLength(0);
  });

  it('normalizes app-shaped permissions before casting user ids in CreateRecord SQL', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: [{ id: 'records:real-1' }] }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('CreateRecord', {
      id: 'temp:1',
      text: 'with permissions',
      permissions: [{ role: 'editor', user_id: 'users:abc' }]
    });
    await engine.pushOps();

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    expect(body).toContain('LET $perms = [{"r":"editor","u":"users:abc"}];');
    expect(body).toContain('type::record($p.u)');
  });

  it('fails malformed permissions before sending CreateRecord SQL', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('CreateRecord', {
      id: 'temp:1',
      text: 'bad permissions',
      permissions: [{ role: 'editor' }]
    });
    await engine.pushOps();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(engine.getPendingOps()[0]?.last_error).toContain('CreateRecord.permissions[0]: permission is missing a valid user id');
  });

  it('writes grouping membership idempotently to the schema groups table', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: [{ id: 'groups:edge-1', in: 'records:scope-1', out: 'records:event-1' }] }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('AddGrouping', { src: 'records:scope-1', dst: 'records:event-1' });
    await engine.pushOps();

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    expect(body).toContain('SELECT * FROM groups WHERE in = $s AND out = $d LIMIT 1');
    expect(body).toContain('RELATE $s->groups->$d CONTENT $payload');
    expect(body).not.toContain('RELATE $s->grouping->$d CONTENT $payload');
    expect(cache.upsert_graph_child_of_edge).toHaveBeenCalledWith(
      'groups:edge-1',
      'records:event-1',
      'records:scope-1',
      0,
      false,
      undefined
    );
    expect(liveBus.broadcast).toHaveBeenCalledWith({
      type: 'GraphChildUpsert',
      edge: {
        edge_id: 'groups:edge-1',
        child_id: 'records:event-1',
        parent_id: 'records:scope-1',
        order: 0,
        is_key_parent: false,
        module_data: undefined,
        clone_setting: null
      }
    });
    expect(cache.notify_sync_idle).toHaveBeenCalledTimes(1);
  });

  it('batches many group/applies relation deltas into one op writing to groups and appliesto', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          status: 'OK',
          result: {
            addedGroups: [
              { id: 'groups:g1', in: 'records:grp1', out: 'records:event-1' },
              { id: 'groups:g2', in: 'records:grp2', out: 'records:event-1' }
            ],
            addedApplies: [
              { id: 'appliesto:a1', in: 'records:event-1', out: 'records:conn-1' }
            ]
          }
        }
      ])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('UpdateRelationsBatch', {
      addGroups: [
        { src: 'records:grp1', dst: 'records:event-1' },
        { src: 'records:grp2', dst: 'records:event-1' }
      ],
      removeGroups: [{ id: 'groups:old-1' }],
      addApplies: [{ src: 'records:event-1', dst: 'records:conn-1' }],
      removeApplies: [{ id: 'appliesto:old-1' }]
    });
    await engine.pushOps();

    // ONE op → ONE HTTP request. This is the fix for the calendar APPLY TEMPLATE
    // op storm (previously N AddGrouping/RemoveGrouping/AddApplies/RemoveApplies
    // ops, each its own transaction — the SDK has no coalescing).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    // Writes only to the schema-defined tables — never the phantom `applies` table.
    expect(body).toContain('RELATE $ag_0_s->groups->$ag_0_d');
    expect(body).toContain('RELATE $aa_0_s->appliesto->$aa_0_d');
    expect(body).not.toContain('->applies->');
    // Idempotency guards on both add kinds (replay-safe; mirrors AddGrouping).
    expect(body).toContain('SELECT * FROM groups WHERE in = $ag_0_s AND out = $ag_0_d LIMIT 1');
    expect(body).toContain('SELECT * FROM appliesto WHERE in = $aa_0_s AND out = $aa_0_d LIMIT 1');
    // Removes are plain idempotent DELETEs of the concrete edge ids.
    expect(body).toContain('DELETE type::record($rg_0)');
    expect(body).toContain('DELETE type::record($ra_0)');
    // Single consolidated RETURN carrying the added edges for local apply.
    expect(body).toContain('RETURN { addedGroups: [$ag_0, $ag_1], addedApplies: [$aa_0] };');

    // Both added groups upserted into the child-edge cache (in=group, out=member).
    expect(cache.upsert_graph_child_of_edge).toHaveBeenCalledWith(
      'groups:g1', 'records:event-1', 'records:grp1', 0, false, undefined, null
    );
    expect(cache.upsert_graph_child_of_edge).toHaveBeenCalledWith(
      'groups:g2', 'records:event-1', 'records:grp2', 0, false, undefined, null
    );
    // Added applies edge upserted into the applies-edge cache.
    expect(cache.upsert_applies_edge).toHaveBeenCalledWith(
      'appliesto:a1', 'records:event-1', 'records:conn-1', undefined
    );
    // Removals applied from the payload ids (idempotent cache removes).
    expect(cache.remove_graph_child).toHaveBeenCalledWith('groups:old-1');
    expect(cache.remove_applies_edge).toHaveBeenCalledWith('appliesto:old-1');
    // Broadcasts to sibling tabs for immediacy (changefeed also delivers idempotently).
    expect(liveBus.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'GraphChildBatchUpsert' }));
    expect(liveBus.broadcast).toHaveBeenCalledWith({
      type: 'AppliesUpsert', edgeId: 'appliesto:a1', srcId: 'records:event-1', dstId: 'records:conn-1', moduleData: undefined
    });
    expect(liveBus.broadcast).toHaveBeenCalledWith({ type: 'GraphChildDelete', edgeId: 'groups:old-1' });
    expect(liveBus.broadcast).toHaveBeenCalledWith({ type: 'AppliesDelete', edgeId: 'appliesto:old-1' });
    // Op drained from the queue.
    expect(engine.getPendingOps()).toHaveLength(0);
    expect(cache.notify_sync_idle).toHaveBeenCalledTimes(1);
  });

  it('writes applies edges idempotently to the schema appliesto table, not the phantom applies table', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        { status: 'OK', result: [{ id: 'appliesto:edge-1', in: 'records:src', out: 'records:dst' }] }
      ])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('AddApplies', { src: 'records:src', dst: 'records:dst' });
    await engine.pushOps();

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(typeof body).toBe('string');
    // Schema-defined table only (appliesto has the changefeed/permissions/indexes;
    // the legacy `->applies->` form wrote to a phantom table that never persisted).
    expect(body).toContain('RELATE $s->appliesto->$d');
    expect(body).toContain('SELECT * FROM appliesto WHERE in = $s AND out = $d LIMIT 1');
    expect(body).not.toContain('->applies->');
  });

  it('rewrites referenced temp ids across pending op payload shapes after a remap', () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('MoveChild', {
      id: 'edges:1',
      childId: 'temp:1',
      oldParentId: 'records:parent-a',
      newParentId: 'temp:1',
      nested: {
        parentId: 'temp:1'
      }
    });

    persistOpMock.mockClear();

    engine.applyRemote({ type: 'TempIdRemap', tempId: 'temp:1', realId: 'records:real-1' });

    expect(persistOpMock).toHaveBeenCalledWith(
      'test-sync',
      expect.objectContaining({
        payload: expect.objectContaining({
          childId: 'records:real-1',
          newParentId: 'records:real-1',
          nested: expect.objectContaining({
            parentId: 'records:real-1'
          })
        })
      })
    );
  });

  it('applies applies-edge messages without routing them through the child-edge cache', () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.applyRemote({
      type: 'AppliesUpsert',
      edgeId: 'applies:1',
      srcId: 'records:source',
      dstId: 'records:dest'
    });

    expect(cache.upsert_applies_edge).toHaveBeenCalledWith(
      'applies:1',
      'records:source',
      'records:dest',
      undefined
    );
    expect(cache.upsert_graph_child_of_edge).not.toHaveBeenCalled();
  });

  it('merges partial grouping edge live updates with the cached edge shape', () => {
    const cache = createCacheStub();
    cache.childrenEdges.get.mockReturnValue({
      edge_id: 'grouping:1',
      parent_id: 'records:parent',
      child_id: 'records:child',
      order: 7,
      is_key_parent: false,
      module_data: { layout: 'old' }
    });
    const liveBus = createBusStub();

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.applyRemote({
      type: 'GraphChildUpsert',
      edge: {
        edge_id: 'grouping:1',
        parent_id: '',
        child_id: '',
        order: Number.NaN,
        is_key_parent: false,
        module_data: { layout: 'new' }
      }
    });

    expect(cache.upsert_graph_child_of_edge).toHaveBeenCalledWith(
      'grouping:1',
      'records:child',
      'records:parent',
      7,
      false,
      { layout: 'new' },
      null
    );
  });

  it('merges partial applies edge live updates with the cached edge endpoints', () => {
    const cache = createCacheStub();
    cache.appliesEdges.get.mockReturnValue({
      edge_id: 'applies:1',
      src_id: 'records:source',
      dst_id: 'records:dest',
      module_data: { state: 'old' }
    });
    const liveBus = createBusStub();

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.applyRemote({
      type: 'AppliesUpsert',
      edgeId: 'applies:1',
      srcId: '',
      dstId: '',
      moduleData: { state: 'new' }
    });

    expect(cache.upsert_applies_edge).toHaveBeenCalledWith(
      'applies:1',
      'records:source',
      'records:dest',
      { state: 'new' }
    );
  });

  it('keeps explicitly unsupported graph-child module-data patches as safe no-ops', () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    expect(() => {
      engine.applyRemote({
        type: 'GraphChildModuleDataPatch',
        edgeId: 'grouping:1',
        moduleData: { layout: 'stacked' }
      });
    }).not.toThrow();

    expect(cache.upsert_graph_child_of_edge).not.toHaveBeenCalled();
    expect(cache.upsert_applies_edge).not.toHaveBeenCalled();
  });

  it('fires cleanup query after accepted CreateRecord', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: [{ id: 'records:real-1' }] }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('CreateRecord', { id: 'temp:1', text: 'hello' });
    await engine.pushOps();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cleanupBody = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body;
    expect(typeof cleanupBody).toBe('string');
    expect(cleanupBody).toContain('UPDATE records UNSET _sync_op_id WHERE _sync_op_id IN $op_ids');
    expect(cleanupBody).toContain('UPDATE graph_child_of UNSET _sync_op_id WHERE _sync_op_id IN $op_ids');
    expect(cleanupBody).toContain('UPDATE groups UNSET _sync_op_id WHERE _sync_op_id IN $op_ids');
  });

  it('fires cleanup query after accepted CreateTreeBatch', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          status: 'OK',
          result: {
            records: [{ id: 'records:real-1' }],
            edges: [],
            groupEdges: []
          }
        }
      ])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('CreateTreeBatch', {
      records: [{ tempId: 'temp:root', content: { text: 'root' } }],
      edges: [],
      groupEdges: [],
      optimisticTempIds: ['temp:root'],
      optimisticTempEdgeIds: [],
      optimisticGroupTempEdgeIds: []
    });
    await engine.pushOps();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cleanupBody = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body;
    expect(typeof cleanupBody).toBe('string');
    expect(cleanupBody).toContain('UPDATE records UNSET _sync_op_id WHERE _sync_op_id IN $op_ids');
    expect(cleanupBody).toContain('UPDATE graph_child_of UNSET _sync_op_id WHERE _sync_op_id IN $op_ids');
    expect(cleanupBody).toContain('UPDATE groups UNSET _sync_op_id WHERE _sync_op_id IN $op_ids');
  });

  // Bug 3 / engine remap ordering: on CreateTreeBatch accept the temp->real
  // remap MUST be broadcast AFTER the record + edge batch upserts, so the
  // reconciler's final pass sees the remapped slice (the real cores + edges are
  // already placed when TempIdRemap lands). If the remap fires first, a
  // reconciler keyed on the temp id bridges onto the real id before the real
  // rows exist and the item vanishes until a refetch. This pins the ordering
  // the Calendar grace safety-net + reconciler depend on (see
  // calendar-reconciler.todo.test.ts "engine: TempIdRemap is emitted last").
  it('emits TempIdRemap LAST (after RecordBatchUpsert + GraphChildBatchUpsert) on CreateTreeBatch accept', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          status: 'OK',
          result: {
            records: [
              { id: 'records:root', text: 'Root' },
              { id: 'records:child', text: 'Child' }
            ],
            edges: [
              { id: 'graph_child_of:child-root', in: 'records:child', out: 'records:root', order: 0, key_parent: true }
            ],
            temp_ids: ['records:root', 'records:child']
          }
        }
      ])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('CreateTreeBatch', {
      records: [
        { tempId: 'temp:root', content: { text: 'Root' } },
        { tempId: 'temp:child', content: { text: 'Child' } }
      ],
      edges: [
        {
          tempEdgeId: 'graph_child_of:temp-child-root',
          childTempId: 'temp:child',
          parentRef: { kind: 'temp', tempId: 'temp:root' },
          order: 0,
          key_parent: true
        }
      ],
      optimisticTempIds: [],
      optimisticTempEdgeIds: []
    });
    await engine.pushOps();

    // The real cores + edges were bulk-applied to the cache before the remap.
    expect(cache.batch_upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'records:root', sync_status: 'accepted' }),
        expect.objectContaining({ id: 'records:child', sync_status: 'accepted' })
      ])
    );
    expect(cache.upsert_graph_child_of_edge).toHaveBeenCalledWith(
      'graph_child_of:child-root', 'records:child', 'records:root', 0, true, undefined, null
    );
    // remap_id was called for each temp->real pair.
    expect(cache.remap_id).toHaveBeenCalledWith('temp:root', 'records:root');
    expect(cache.remap_id).toHaveBeenCalledWith('temp:child', 'records:child');

    // Broadcast ordering: every data upsert precedes every TempIdRemap.
    const types = liveBus.broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('RecordBatchUpsert');
    expect(types).toContain('GraphChildBatchUpsert');
    expect(types.filter((t) => t === 'TempIdRemap').length).toBe(2); // one per remapped temp id

    const lastUpsertIndex = Math.max(
      types.lastIndexOf('RecordBatchUpsert'),
      types.lastIndexOf('GraphChildBatchUpsert')
    );
    const firstRemapIndex = types.indexOf('TempIdRemap');
    // The first TempIdRemap lands strictly after the last record/edge batch
    // upsert — no remap is interleaved ahead of the data it remaps.
    expect(firstRemapIndex).toBeGreaterThan(lastUpsertIndex);
  });

  // queueOp MUST de-proxy the payload before it enters the op pipeline. A
  // Svelte $state proxy nested in the payload crashes BroadcastChannel.postMessage
  // (and IDB) with DataCloneError and the op sticks pending/inflight forever —
  // the "new events stuck InFlight" bug. The cache's clonePlain does the
  // $state.snapshot + structuredClone; this proves queueOp routes the payload
  // through it and the broadcast op carries the CLONE, not the caller's input.
  it('de-proxies the payload in queueOp so the broadcast op carries a plain clone', async () => {
    const cache = createCacheStub();
    const originalPayload = {
      records: [{ tempId: 'temp:x', content: { text: 'T' } }],
      edges: []
    };
    // Simulate the cache's clonePlain: return a DISTINCT plain object so we can
    // prove the op stores the clone, not the (possibly proxy) caller input.
    const clonedPayload = JSON.parse(JSON.stringify(originalPayload));
    cache.clonePlain = vi.fn(() => clonedPayload) as any;
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: { records: [], edges: [] } }])
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('CreateTreeBatch', originalPayload);

    // clonePlain was invoked with the raw caller payload...
    expect(cache.clonePlain).toHaveBeenCalledWith(originalPayload);
    // ...and the broadcast OpUpsert carries the CLONE (de-proxied payload), so
    // postMessage gets plain structured-cloneable data, not the caller's input.
    const opUpsert = liveBus.broadcast.mock.calls.find(
      (c) => (c[0] as { type?: string }).type === 'OpUpsert'
    );
    expect(opUpsert).toBeTruthy();
    expect((opUpsert![0] as any).op.payload).toBe(clonedPayload);
    expect((opUpsert![0] as any).op.payload).not.toBe(originalPayload);
  });

  it('skips cleanup query when sync fails', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValue({
      ok: false,
      statusText: 'Internal Server Error'
    } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('CreateRecord', { id: 'temp:1', text: 'hello' });
    await engine.pushOps();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not block sync when cleanup query fails', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([{ status: 'OK', result: [{ id: 'records:real-1' }] }])
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: vi.fn().mockResolvedValue('')
      } as unknown as Response);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    engine.queueOp('CreateRecord', { id: 'temp:1', text: 'hello' });
    await engine.pushOps();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deleteOpMock).toHaveBeenCalled();
    expect(cache.remap_id).toHaveBeenCalledWith('temp:1', 'records:real-1');
  });

  it('drains ops queued while a push is already in flight (rapid succession)', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    // Simulate a second rapid user action (e.g. checking off another exec
    // item) landing WHILE op1's request is in flight. engine.queueOp does NOT
    // call pushOps (that's queueAndWake's job at the runtime layer), and the
    // in-flight lock makes a concurrent pushOps() a no-op, so the ONLY thing
    // that can flush op2 promptly is pushOps' post-push drain. Without the
    // drain, op2 sits pending until the next ~30s sync-loop tick — which is
    // exactly why a parent's computed "done" state failed to appear until a
    // manual refresh.
    let queuedSecond = false;
    fetchMock.mockImplementation(async () => {
      if (!queuedSecond) {
        queuedSecond = true;
        engine.queueOp('UpdateRecord', {
          id: 'records:2',
          additionals: [{ id: 'pg2', type: 'pg', prog_type: { ch: 't' }, computed: false }]
        });
      }
      return {
        ok: true,
        json: vi.fn().mockResolvedValue([{ status: 'OK', result: null }])
      } as unknown as Response;
    });

    engine.queueOp('UpdateRecord', {
      id: 'records:1',
      additionals: [{ id: 'pg1', type: 'pg', prog_type: { ch: 't' }, computed: false }]
    });
    await engine.pushOps();

    // Both ops flushed within the single pushOps() chain — nothing left behind.
    expect(engine.getPendingOps()).toHaveLength(0);
    const bodies = fetchMock.mock.calls
      .map(call => (call[1] as RequestInit | undefined)?.body)
      .filter((b): b is string => typeof b === 'string');
    expect(bodies.some(b => b.includes('LET $id = "records:1";'))).toBe(true);
    expect(bodies.some(b => b.includes('LET $id = "records:2";'))).toBe(true);
  });

  it('re-drains a cross-tab op that lands in IDB (via SyncWake) during an in-flight push', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    // A follower tab writes op2 to shared IDB and broadcasts SyncWake while the
    // leader is mid-push. The leader picks up follower ops ONLY via
    // loadPendingOps at the start of pushOps, so op2 is invisible to the
    // in-memory snapshot/late-op check — it can only be drained because the
    // SyncWake-driven pushOps collision set pushRequestedDuringFlight, and the
    // re-run reloads IDB. Surface op2 from loadPendingOps from the 2nd call on.
    loadPendingOpsMock.mockImplementation(async () => {
      return loadPendingOpsMock.mock.calls.length > 1
        ? [{ id: 'op-follower', kind: 'UpdateRecord', payload: { id: 'records:2', text: 'from other tab' }, retries: 0, created: Date.now(), updated: Date.now() }]
        : [];
    });

    let wokeLeader = false;
    fetchMock.mockImplementation(async () => {
      // Simulate the cross-tab SyncWake arriving mid-push: the leader handles it
      // with a bare pushOps() that collides with the in-flight lock.
      if (!wokeLeader) {
        wokeLeader = true;
        void engine.pushOps();
      }
      return {
        ok: true,
        json: vi.fn().mockResolvedValue([{ status: 'OK', result: null }])
      } as unknown as Response;
    });

    engine.queueOp('UpdateRecord', { id: 'records:1', text: 'from this tab' });
    await engine.pushOps();

    const bodies = fetchMock.mock.calls
      .map(call => (call[1] as RequestInit | undefined)?.body)
      .filter((b): b is string => typeof b === 'string');
    expect(bodies.some(b => b.includes('LET $id = "records:1";'))).toBe(true);
    expect(bodies.some(b => b.includes('LET $id = "records:2";'))).toBe(true);
  });

  it('does not re-drain (or hot-loop) when the only pending op stays deferred', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    const engine = createSyncEngine(cache as any, liveBus as any, {
      url: 'http://localhost:8000',
      namespace: 'app',
      storageNamespace: 'test-sync',
      database: 'main',
      token: 'token',
      scopes: []
    });

    // An op deferred waiting for a temp id that never resolves stays pending
    // forever. The post-push drain keys off ops that arrived AFTER the
    // snapshot, so this op — present in the snapshot — must NOT retrigger
    // pushOps; otherwise it would spin into an infinite loop. If the guard
    // regressed, this test would hang rather than fail.
    engine.queueOp('AddChild', {
      parent: 'records:parent-1',
      child: 'temp:child-1',
      order: 0,
      key_parent: true
    });
    await engine.pushOps();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(engine.getPendingOps()).toHaveLength(1);
  });
});

describe('sync engine push scheduler', () => {
  const engineConfig = {
    url: 'http://localhost:8000',
    namespace: 'app',
    storageNamespace: 'test-sync',
    database: 'main',
    token: 'token',
    scopes: []
  };

  function okResponse(result: unknown = null): Response {
    return {
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result }])
    } as unknown as Response;
  }

  function conflictResponse(): Response {
    return {
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'ERR', detail: 'read or write conflict' }])
    } as unknown as Response;
  }

  // build_op_vars always returns this fixed 13-key shape for every
  // single-op-kind op, regardless of op.kind. buildSurrealStatement inlines
  // each combinedVars entry as its own top-level `LET $x = …;` statement
  // ahead of a batch envelope's `{ }` blocks, and the HTTP /sql response
  // carries one {status:'OK', result:null} entry per top-level statement —
  // so a REAL batch-envelope response has `13 * opCount` leading "LET-prefix
  // noise" entries before the actual per-op block results (runBatchEnvelope
  // skips exactly that many). Mocked responses in these tests must include
  // that same leading noise to exercise the real slicing logic.
  const VARS_PER_OP = 13;
  function batchResponse(perOpResults: unknown[]): Response {
    const letPrefixNoise = Array.from({ length: VARS_PER_OP * perOpResults.length }, () => ({ status: 'OK', result: null }));
    return {
      ok: true,
      json: vi.fn().mockResolvedValue([...letPrefixNoise, ...perOpResults])
    } as unknown as Response;
  }

  /** fetch mock that parks every call until the test resolves it, keyed by body. */
  function deferredFetch() {
    const calls: Array<{ body: string; resolve: (response: Response) => void }> = [];
    const impl = (_url: unknown, init?: { body?: unknown }) =>
      new Promise<Response>((resolve) => {
        calls.push({ body: String(init?.body ?? ''), resolve });
      });
    return { calls, impl };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loadPendingOpsMock.mockResolvedValue([]);
    loadAllOpsMock.mockResolvedValue([]);
    persistOpMock.mockResolvedValue(undefined);
    deleteOpMock.mockResolvedValue(undefined);
    updateOpStatusMock.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('batches independent ops into ONE combined request (M10)', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const { calls, impl } = deferredFetch();
    fetchMock.mockImplementation(impl as any);

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    for (let index = 0; index < 6; index += 1) {
      engine.queueOp('UpdateRecord', { id: `records:r${index}`, text: `t${index}` });
    }
    const push = engine.pushOps();

    // All 6 are independent, single-op-kind, and well under
    // BATCH_ENVELOPE_SIZE (25) — they combine into ONE request instead of
    // one-per-op (the old MAX_CONCURRENT_PUSHES=4-at-a-time behavior this
    // replaces — see "no server spam on reconnect" in the offline audit).
    await vi.waitFor(() => expect(calls.length).toBe(1));
    for (let index = 0; index < 6; index += 1) {
      expect(calls[0].body).toContain(`t${index}`);
    }

    calls[0].resolve(batchResponse(Array.from({ length: 6 }, () => ({ status: 'OK', result: null }))));

    // Post-drain marker cleanup is one more HTTP call.
    await vi.waitFor(() => expect(calls.length).toBe(2));
    calls[1].resolve(okResponse());
    await push;
    expect(engine.getPendingOps()).toHaveLength(0);
  });

  it('caps concurrent batch envelopes at MAX_CONCURRENT_PUSHES when the backlog exceeds BATCH_ENVELOPE_SIZE', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const { calls, impl } = deferredFetch();
    fetchMock.mockImplementation(impl as any);

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    // 130 independent ops → ceil(130/25) = 6 envelopes, so the 5th/6th must
    // wait for one of the first 4 (the concurrency cap) to free a slot.
    for (let index = 0; index < 130; index += 1) {
      engine.queueOp('UpdateRecord', { id: `records:r${index}`, text: `t${index}` });
    }
    const push = engine.pushOps();

    await vi.waitFor(() => expect(calls.length).toBe(4));
    // A 5th envelope must not launch until one of the 4 settles.
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(4);

    for (let i = 0; i < 4; i++) {
      calls[i].resolve(batchResponse(Array.from({ length: 25 }, () => ({ status: 'OK', result: null }))));
    }
    await vi.waitFor(() => expect(calls.length).toBe(6)); // remaining 2 envelopes (25+5 ops)
    calls[4].resolve(batchResponse(Array.from({ length: 25 }, () => ({ status: 'OK', result: null }))));
    calls[5].resolve(batchResponse(Array.from({ length: 5 }, () => ({ status: 'OK', result: null }))));
    await vi.waitFor(() => expect(calls.length).toBe(7)); // marker cleanup
    calls[6].resolve(okResponse());
    await push;
    expect(engine.getPendingOps()).toHaveLength(0);
  }, 10000);

  it('a batch-mate\'s error is isolated: siblings in the same envelope still succeed', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    // 3 ops in the batch: first OK, second ERR, third OK — SurrealDB
    // isolates block errors per top-level statement (verified against a
    // live instance), so this shape is what a real mixed-outcome envelope
    // response looks like.
    fetchMock.mockResolvedValue(batchResponse([
      { status: 'OK', result: null },
      { status: 'ERR', detail: 'permission denied' },
      { status: 'OK', result: null }
    ]));

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    engine.queueOp('UpdateRecord', { id: 'records:ok1', text: 'a' });
    engine.queueOp('UpdateRecord', { id: 'records:bad', text: 'b' });
    engine.queueOp('UpdateRecord', { id: 'records:ok2', text: 'c' });
    await engine.pushOps();

    const pending = engine.getPendingOps();
    expect(pending).toHaveLength(1);
    expect((pending[0].payload as any).id).toBe('records:bad');
    expect(pending[0].last_error).toContain('permission denied');
  });

  it('exactly one ready batchable op skips the envelope path (no batching benefit)', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(okResponse());

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    engine.queueOp('UpdateRecord', { id: 'records:solo', text: 'x' });
    await engine.pushOps();

    // First call is the op itself; the second (UpdateRecord is a
    // shouldStampMarker kind) is the post-accept cleanupSyncMarkers call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = String((fetchMock.mock.calls[0]?.[1] as any)?.body ?? '');
    // The solo path sends the op's SQL directly — not wrapped in a `{ }`
    // batch-envelope block.
    expect(body.startsWith('{')).toBe(false);
  });

  it('keeps ops targeting the same record strictly FIFO while unrelated ops overlap (batched)', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const { calls, impl } = deferredFetch();
    fetchMock.mockImplementation(impl as any);

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    engine.queueOp('UpdateRecord', { id: 'records:A', text: 'a-first' });
    engine.queueOp('UpdateRecord', { id: 'records:A', text: 'a-second' });
    engine.queueOp('UpdateRecord', { id: 'records:B', text: 'b' });
    const push = engine.pushOps();

    // a-first and the unrelated b op are BOTH ready and batchable, so they
    // combine into ONE envelope request; a-second is gated behind a-first
    // (same-key FIFO) and is not part of it.
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].body).toContain('a-first');
    expect(calls[0].body).toContain('b');
    expect(calls[0].body).not.toContain('a-second');

    calls[0].resolve(batchResponse([{ status: 'OK', result: null }, { status: 'OK', result: null }]));

    // a-second becomes ready once a-first settles, and launches solo (it's
    // the only batchable op ready at that point).
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].body).toContain('a-second');
    calls[1].resolve(okResponse());

    await vi.waitFor(() => expect(calls.length).toBe(3)); // marker cleanup
    calls[2].resolve(okResponse());
    await push;
    expect(engine.getPendingOps()).toHaveLength(0);
  });

  it('releases a temp-id dependent within the SAME drain once its producer accepts', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
      const body = String(init?.body ?? '');
      if (body.includes('CREATE records')) return okResponse([{ id: 'records:real1' }]);
      return okResponse(null);
    });

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    engine.queueOp('CreateRecord', { id: 'temp:X', text: 'new' });
    engine.queueOp('AddChild', { child: 'temp:X', parent: 'records:p', order: 0 });
    await engine.pushOps();

    // The old drain exited after the create and parked the AddChild until the
    // next ~30s sync-loop tick. Now it flushes in the same drain, rewritten.
    expect(engine.getPendingOps()).toHaveLength(0);
    const addChildCall = vi
      .mocked(fetch)
      .mock.calls.find(([, init]) => String((init as any)?.body).includes('graph_child_of'));
    expect(addChildCall).toBeTruthy();
    expect(String((addChildCall![1] as any).body)).toContain('records:real1');
    expect(String((addChildCall![1] as any).body)).not.toContain('temp:X');
  });

  it('defers an op whose temp id has no producer in the drain, without a network attempt', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    engine.queueOp('AddChild', { child: 'temp:missing', parent: 'records:p' });
    await engine.pushOps();

    expect(fetchMock).not.toHaveBeenCalled();
    const pending = engine.getPendingOps();
    expect(pending).toHaveLength(1);
    expect(pending[0].last_error).toContain('waiting for temp ids: temp:missing');
  });

  it('cascade-rejects dependents whose temp-id producer is rejected in the drain', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    // Every attempt fails hard: the producer (already at retries=4) crosses
    // MAX_RETRIES and is rejected.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: vi.fn().mockResolvedValue('')
    } as unknown as Response);

    const now = Date.now();
    loadPendingOpsMock.mockResolvedValue([
      {
        id: 'op_producer',
        kind: 'CreateRecord',
        payload: { id: 'temp:X', text: 'x' },
        status: 'pending',
        created: now,
        retries: 4,
        last_error: 'Sync failed: Internal Server Error',
        last_attempt_at: 0,
        updated: now
      },
      {
        id: 'op_dependent',
        kind: 'AddChild',
        payload: { child: 'temp:X', parent: 'records:p', optimisticEdgeId: 'temp-edge:e1' },
        status: 'pending',
        created: now,
        retries: 0,
        updated: now
      }
    ]);

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    await engine.pushOps();

    expect(engine.getPendingOps()).toHaveLength(0);
    // Producer's optimistic record and the dependent's optimistic edge are
    // both rolled back; the dependent explains why it was rejected.
    expect(cache.removeItem).toHaveBeenCalledWith('temp:X');
    expect(cache.remove_graph_child).toHaveBeenCalledWith('temp-edge:e1');
    expect(persistOpMock).toHaveBeenCalledWith(
      'test-sync',
      expect.objectContaining({
        id: 'op_dependent',
        status: 'rejected',
        last_error: expect.stringContaining('temp:X')
      })
    );
  });

  it('treats DeleteTree as a barrier: nothing straddles it', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const { calls, impl } = deferredFetch();
    fetchMock.mockImplementation(impl as any);

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    engine.queueOp('UpdateRecord', { id: 'records:A', text: 'before-delete' });
    engine.queueOp('DeleteTree', { id: 'records:B' });
    engine.queueOp('UpdateRecord', { id: 'records:C', text: 'after-delete' });
    const push = engine.pushOps();

    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].body).toContain('before-delete');

    calls[0].resolve(okResponse());
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].body).toContain('delete_and_children');
    expect(calls.some((call) => call.body.includes('after-delete'))).toBe(false);

    calls[1].resolve(okResponse());
    await vi.waitFor(() => expect(calls.length).toBe(3));
    expect(calls[2].body).toContain('after-delete');

    calls[2].resolve(okResponse());
    await vi.waitFor(() => expect(calls.length).toBe(4)); // marker cleanup
    calls[3].resolve(okResponse());
    await push;
    expect(engine.getPendingOps()).toHaveLength(0);
  });

  it('same-tick pushOps calls share ONE drain: a gated dependent is not deferred by a racing drain', async () => {
    // Regression: the lock used to be claimed only after an await, so two
    // pushOps entering in the same tick both passed the null-check and ran
    // overlapping drains. The second drain saw the producer as inflight (not
    // pending), concluded the dependent's temp id had no producer, and
    // deferred it — stranding it for the next tick.
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const { calls, impl } = deferredFetch();
    fetchMock.mockImplementation(impl as any);

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    engine.queueOp('CreateRecord', { id: 'temp:X', text: 'x' });
    engine.queueOp('AddChild', { child: 'temp:X', parent: 'records:p' });
    const firstPush = engine.pushOps();
    const secondPush = engine.pushOps();

    // Only the producer goes out; the dependent is gated in the same drain,
    // and no racing drain has marked it deferred.
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(persistOpMock).not.toHaveBeenCalledWith(
      'test-sync',
      expect.objectContaining({ last_error: expect.stringContaining('waiting for temp ids') })
    );

    calls[0].resolve(okResponse([{ id: 'records:real1' }]));
    await vi.waitFor(() => expect(calls.length).toBe(2)); // dependent released in-drain
    expect(calls[1].body).toContain('records:real1');
    calls[1].resolve(okResponse());
    await vi.waitFor(() => expect(calls.length).toBe(3)); // marker cleanup
    calls[2].resolve(okResponse());
    await Promise.all([firstPush, secondPush]);
    expect(engine.getPendingOps()).toHaveLength(0);
  });

  it('cancelOp removes a queued op and cascades to its temp-id dependents', () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    const producer = engine.queueOp('CreateRecord', { id: 'temp:X', text: 'x' });
    const dependent = engine.queueOp('AddChild', {
      child: 'temp:X',
      parent: 'records:p',
      optimisticEdgeId: 'temp-edge:e1'
    });
    const unrelated = engine.queueOp('UpdateRecord', { id: 'records:other', text: 'keep' });

    expect(engine.cancelOp(producer.id)).toBe(true);

    expect(engine.getPendingOps().map((op) => op.id)).toEqual([unrelated.id]);
    expect(cache.removeItem).toHaveBeenCalledWith('temp:X');
    expect(cache.remove_graph_child).toHaveBeenCalledWith('temp-edge:e1');
    expect(deleteOpMock).toHaveBeenCalledWith('test-sync', producer.id);
    expect(deleteOpMock).toHaveBeenCalledWith('test-sync', dependent.id);
    expect(liveBus.broadcast).toHaveBeenCalledWith({ type: 'OpCancel', id: producer.id });
    expect(liveBus.broadcast).toHaveBeenCalledWith({ type: 'OpCancel', id: dependent.id });

    expect(engine.cancelOp('op_unknown')).toBe(false);
  });

  it('cancelOp refuses an inflight op', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const { calls, impl } = deferredFetch();
    fetchMock.mockImplementation(impl as any);

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    const op = engine.queueOp('UpdateRecord', { id: 'records:A', text: 'a' });
    const push = engine.pushOps();
    await vi.waitFor(() => expect(calls.length).toBe(1));

    expect(engine.cancelOp(op.id)).toBe(false);

    calls[0].resolve(okResponse());
    await vi.waitFor(() => expect(calls.length).toBe(2)); // marker cleanup
    calls[1].resolve(okResponse());
    await push;
  });

  it('applyRemote OpCancel prunes the local oplog copy of a pending op', () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    const op = engine.queueOp('CreateRecord', { id: 'temp:X', text: 'x' });
    engine.applyRemote({ type: 'OpCancel', id: op.id } as any);

    expect(engine.getPendingOps()).toHaveLength(0);
    expect(cache.removeItem).toHaveBeenCalledWith('temp:X');
  });

  it('retries a conflict-failed op at its own backoff expiry, without a sync-loop tick', async () => {
    vi.useFakeTimers();
    try {
      const cache = createCacheStub();
      const liveBus = createBusStub();
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(conflictResponse()).mockResolvedValue(okResponse(null));

      const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
      // The retry wake only arms while a sync loop is active (as in
      // production); its base 30s tick is far beyond what we advance here.
      const stopLoop = engine.startSyncLoop();
      try {
        const op = engine.queueOp('UpdateRecord', { id: 'records:A', text: 'a' });
        await engine.pushOps();

        // Failed retryably; backing off on the fast conflict curve
        // (500ms + deterministic jitter < 750ms), NOT the 5s error curve.
        expect(op.status).toBe('pending');
        expect(op.retries).toBe(1);

        // No explicit pushOps, no 30s tick — the armed retry wake fires it.
        await vi.advanceTimersByTimeAsync(1000);
        expect(engine.getPendingOps()).toHaveLength(0);
      } finally {
        stopLoop();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('offline resilience (M7)', () => {
  const engineConfig = {
    url: 'http://localhost:8000',
    namespace: 'app',
    storageNamespace: 'test-sync',
    database: 'main',
    token: 'token',
    scopes: []
  };

  beforeEach(() => {
    vi.clearAllMocks();
    loadPendingOpsMock.mockResolvedValue([]);
    loadAllOpsMock.mockResolvedValue([]);
    persistOpMock.mockResolvedValue(undefined);
    deleteOpMock.mockResolvedValue(undefined);
    updateOpStatusMock.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('classifies fetch/network failures distinctly from server rejections', () => {
    expect(isNetworkSyncError(new TypeError('Failed to fetch'))).toBe(true);
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    expect(isNetworkSyncError(abortError)).toBe(true);
    expect(isNetworkSyncError(new Error('permission denied'))).toBe(false);
    expect(isNetworkSyncError('not an error object')).toBe(false);
  });

  it('never rejects (or rolls back) an op failing for network reasons, past the standard retry cap', async () => {
    vi.useFakeTimers();
    try {
      const cache = createCacheStub();
      const liveBus = createBusStub();
      const fetchMock = vi.mocked(fetch);
      // Every attempt fails as a network error — the shape fetch() itself
      // throws for DNS/connection failures or an offline browser.
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
      engine.queueOp('CreateRecord', {
        id: 'temp:1',
        text: 'optimistic node',
        is_temp: true,
        sync_status: 'pending'
      });

      // 8 attempts — well past MAX_RETRIES (5) — each pushed past the
      // network backoff ceiling (NETWORK_MAX_BACKOFF_MS = 60s).
      for (let attempt = 0; attempt < 8; attempt++) {
        await engine.pushOps();
        vi.setSystemTime(Date.now() + 61_000);
      }

      const pending = engine.getPendingOps();
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe('pending');
      expect(pending[0].retries).toBe(8);
      expect(pending[0].last_error_kind).toBe('network');
      // The optimistic temp row must survive — rollback only happens on
      // genuine rejection, which a network-classified op never reaches.
      expect(cache.removeItem).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still rejects a genuine server-side failure at the standard retry cap', async () => {
    vi.useFakeTimers();
    try {
      const cache = createCacheStub();
      const liveBus = createBusStub();
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: vi.fn().mockResolvedValue('validation failed')
      } as unknown as Response);

      const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
      engine.queueOp('CreateRecord', {
        id: 'temp:2',
        text: 'bad node',
        is_temp: true,
        sync_status: 'pending'
      });

      for (let attempt = 0; attempt < 6; attempt++) {
        await engine.pushOps();
        vi.setSystemTime(Date.now() + 301_000);
      }

      expect(engine.getPendingOps()).toHaveLength(0);
      expect(persistOpMock).toHaveBeenLastCalledWith(
        'test-sync',
        expect.objectContaining({
          status: 'rejected',
          last_error_kind: 'server',
          retries: 5
        })
      );
      expect(cache.removeItem).toHaveBeenCalledWith('temp:2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a push attempt entirely when navigator reports offline, without touching retries', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    try {
      const cache = createCacheStub();
      const liveBus = createBusStub();
      const fetchMock = vi.mocked(fetch);

      const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
      engine.queueOp('UpdateRecord', { id: 'records:A', text: 'a' });
      await engine.pushOps();

      expect(fetchMock).not.toHaveBeenCalled();
      const pending = engine.getPendingOps();
      expect(pending).toHaveLength(1);
      expect(pending[0].retries).toBe(0);
      expect(pending[0].last_attempt_at).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retryOp resurrects a rejected op as pending with reset retries, and it can then sync', async () => {
    vi.useFakeTimers();
    try {
      const cache = createCacheStub();
      const liveBus = createBusStub();
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: vi.fn().mockResolvedValue('validation failed')
      } as unknown as Response);

      const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
      const op = engine.queueOp('UpdateRecord', { id: 'records:B', text: 'b' });

      for (let attempt = 0; attempt < 6; attempt++) {
        await engine.pushOps();
        vi.setSystemTime(Date.now() + 301_000);
      }
      expect(engine.getPendingOps()).toHaveLength(0); // rejected, off the pending list

      // Retrying an unknown/non-rejected op id is a no-op.
      expect(await engine.retryOp('op_does_not_exist')).toBe(false);

      fetchMock.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue([{ status: 'OK', result: { id: 'records:B' } }])
      } as unknown as Response);

      expect(await engine.retryOp(op.id)).toBe(true);
      // retryOp resets retries/backoff and persists that BEFORE firing its
      // background push — this call is guaranteed to have happened by the
      // time retryOp's own await resolves, regardless of how fast the
      // (mocked, instant-under-fake-timers) follow-up push then settles.
      expect(persistOpMock).toHaveBeenCalledWith(
        'test-sync',
        expect.objectContaining({
          id: op.id,
          status: 'pending',
          retries: 0,
          last_error: undefined,
          last_error_kind: undefined
        })
      );

      // retryOp fires its own push in the background; awaiting pushOps()
      // again either joins that in-flight drain (via the lock) or, if it has
      // already settled, runs a fresh no-op — either way it's deterministic
      // without relying on real-time polling under fake timers.
      await engine.pushOps();
      expect(engine.getPendingOps()).toHaveLength(0);
      expect(deleteOpMock).toHaveBeenCalledWith('test-sync', op.id);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('conflict detection (M10b)', () => {
  const engineConfig = {
    url: 'http://localhost:8000',
    namespace: 'app',
    storageNamespace: 'test-sync',
    database: 'main',
    token: 'token',
    scopes: []
  };

  beforeEach(() => {
    vi.clearAllMocks();
    loadPendingOpsMock.mockResolvedValue([]);
    loadAllOpsMock.mockResolvedValue([]);
    persistOpMock.mockResolvedValue(undefined);
    deleteOpMock.mockResolvedValue(undefined);
    updateOpStatusMock.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn());
  });

  function conflictMarkerResponse(current: Record<string, unknown> | null, extra: Record<string, unknown> = {}): Response {
    return {
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: { conflict: true, current, op_id: 'irrelevant', ...extra } }])
    } as unknown as Response;
  }

  it('queueOp captures base_updated from the cache at queue time, not flush time', () => {
    const cache = createCacheStub();
    (cache as any).getItem = vi.fn().mockReturnValue({ id: 'records:A', updated: '2026-01-01T00:00:00.000Z' });
    const liveBus = createBusStub();
    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);

    const op = engine.queueOp('UpdateRecord', { id: 'records:A', text: 'edited' });
    expect((op.payload as any)._base_updated).toBe('2026-01-01T00:00:00.000Z');
  });

  it('queueOp leaves base_updated null when the target is not in cache (no baseline to compare)', () => {
    const cache = createCacheStub();
    (cache as any).getItem = vi.fn().mockReturnValue(undefined);
    const liveBus = createBusStub();
    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);

    const op = engine.queueOp('UpdateRecord', { id: 'records:unknown', text: 'edited' });
    expect((op.payload as any)._base_updated).toBeNull();
  });

  it('a {conflict:true} response marks the op conflicted (not accepted/rejected) and does not roll back optimistic state', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const serverCurrent = { id: 'records:A', text: 'server-text', updated: '2026-02-01T00:00:00.000Z' };
    fetchMock.mockResolvedValue(conflictMarkerResponse(serverCurrent, { conflicted_fields: ['text'] }));

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    const op = engine.queueOp('UpdateRecord', { id: 'records:A', text: 'client-text', _base_updated: '2020-01-01T00:00:00.000Z' });
    await engine.pushOps();

    expect(engine.getPendingOps()).toHaveLength(0);
    const conflicted = engine.getConflictedOps();
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0].id).toBe(op.id);
    expect(conflicted[0].conflictCurrent).toEqual(serverCurrent);
    expect(cache.removeItem).not.toHaveBeenCalled();
    expect(cache.update_sync_status).toHaveBeenCalledWith('records:A', 'conflicted');
    // A conflict is a successful round-trip (server reachable, answered) —
    // must not be misclassified as a network/server failure.
    expect(persistOpMock).toHaveBeenLastCalledWith(
      'test-sync',
      expect.objectContaining({ status: 'conflicted', last_error_kind: 'conflict' })
    );
  });

  it('resolveConflict(take-theirs) adopts the server row into the cache and drops the op', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const serverCurrent = { id: 'records:A', text: 'server-text', updated: '2026-02-01T00:00:00.000Z' };
    fetchMock.mockResolvedValue(conflictMarkerResponse(serverCurrent));

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    const op = engine.queueOp('UpdateRecord', { id: 'records:A', text: 'client-text', _base_updated: '2020-01-01T00:00:00.000Z' });
    await engine.pushOps();
    expect(engine.getConflictedOps()).toHaveLength(1);

    const resolved = await engine.resolveConflict(op.id, 'take-theirs');
    expect(resolved).toBe(true);
    expect(engine.getConflictedOps()).toHaveLength(0);
    expect(cache.normalizeItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'records:A', text: 'server-text', dirty: false, sync_status: 'accepted' })
    );
    expect(deleteOpMock).toHaveBeenCalledWith('test-sync', op.id);
  });

  it('resolveConflict(take-theirs) normalizes the adopted server row\'s permissions to the cache shape', async () => {
    // Regression: the take-theirs branch used to hand-build its core (like the
    // pre-fix applySingleOpSuccess), so an adopted server row's permissions
    // kept the stored { r, u } shape -- which the calendar editor's
    // user_id/role filter rejects, dropping every permission the moment a
    // conflict on that record gets resolved this way.
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const serverCurrent = {
      id: 'records:A',
      text: 'server-text',
      updated: '2026-02-01T00:00:00.000Z',
      permissions: [{ r: 'editor', u: 'users:abc', username: 'Alice', user_icon_small: 'img:abc' }]
    };
    fetchMock.mockResolvedValue(conflictMarkerResponse(serverCurrent));

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    const op = engine.queueOp('UpdateRecord', { id: 'records:A', text: 'client-text', _base_updated: '2020-01-01T00:00:00.000Z' });
    await engine.pushOps();

    const resolved = await engine.resolveConflict(op.id, 'take-theirs');
    expect(resolved).toBe(true);
    expect(cache.normalizeItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'records:A',
        permissions: [{ role: 'editor', user_id: 'users:abc', username: 'Alice', user_icon_small: 'img:abc' }]
      })
    );
  });

  it('resolveConflict(take-theirs) with deleted:true drops the local record instead of adopting one', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(conflictMarkerResponse(null, { deleted: true }));

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    const op = engine.queueOp('UpdateRecord', { id: 'records:A', text: 'too-late', _base_updated: '2020-01-01T00:00:00.000Z' });
    await engine.pushOps();
    expect(engine.getConflictedOps()).toHaveLength(1);

    const resolved = await engine.resolveConflict(op.id, 'take-theirs');
    expect(resolved).toBe(true);
    expect(cache.removeItem).toHaveBeenCalledWith('records:A');
    expect(cache.normalizeItem).not.toHaveBeenCalled();
  });

  it('resolveConflict(keep-mine) re-baselines base_updated from the conflict current row and re-queues as pending', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    const fetchMock = vi.mocked(fetch);
    const serverCurrent = { id: 'records:A', text: 'server-text', updated: '2026-02-01T00:00:00.000Z' };
    fetchMock.mockResolvedValue(conflictMarkerResponse(serverCurrent));

    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    const op = engine.queueOp('UpdateRecord', { id: 'records:A', text: 'client-text', _base_updated: '2020-01-01T00:00:00.000Z' });
    await engine.pushOps();
    expect(engine.getConflictedOps()).toHaveLength(1);

    // Switch the mock to accept on the retry so we can observe the re-queue
    // used the fresh baseline rather than checking the SQL string directly.
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ status: 'OK', result: { id: 'records:A', text: 'client-text' } }])
    } as unknown as Response);

    const resolved = await engine.resolveConflict(op.id, 'keep-mine');
    expect(resolved).toBe(true);
    expect(persistOpMock).toHaveBeenCalledWith(
      'test-sync',
      expect.objectContaining({
        id: op.id,
        status: 'pending',
        payload: expect.objectContaining({ _base_updated: serverCurrent.updated })
      })
    );

    await engine.pushOps();
    expect(engine.getPendingOps()).toHaveLength(0);
    expect(engine.getConflictedOps()).toHaveLength(0);
  });

  it('resolveConflict returns false for an unknown or already-settled op id', async () => {
    const cache = createCacheStub();
    const liveBus = createBusStub();
    vi.stubGlobal('fetch', vi.fn());
    const engine = createSyncEngine(cache as any, liveBus as any, engineConfig);
    expect(await engine.resolveConflict('op_does_not_exist', 'take-theirs')).toBe(false);
  });
});
