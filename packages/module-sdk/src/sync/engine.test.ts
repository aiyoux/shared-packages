import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncEngine, isRetryableSyncError } from './engine.ts';

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
    // Idempotency guard mirrors buildTreeBatchSql.
    expect(body).toContain('LET $existing = (SELECT * FROM records WHERE _sync_op_id = $op_id);');
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
    expect(body).toContain('SELECT * FROM records WHERE _sync_op_id = $op_id LIMIT 1');
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
