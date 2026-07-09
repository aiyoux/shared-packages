import { optimisticCacheItemFromItem } from './optimistic-cache.ts';
import { refsObject } from './module-refs.ts';
import { buildQuantityDeltaAdditional } from './scheduler/inventory.ts';
import type { AppRuntime } from './sync/runtime.ts';
import type { Item } from './types.ts';

export interface QueueCreateChildRecordArgs {
  runtime: AppRuntime;
  parentId: string;
  /**
   * Record to create. If `id` is omitted (or undefined) a fresh `temp:` id is
   * generated and returned. Provide an explicit `temp:` id when the caller
   * needs it up front (e.g. to navigate to the new record before sync
   * completes).
   */
  item: Omit<Item, 'id'> & { id?: string };
  order?: number;
  keyParent?: boolean;
}

export interface QueueCreateChildRecordResult {
  recordId: string;
  edgeId: string;
}

/**
 * Optimistic single-record create: writes `item` into the cache as a child of
 * `parentId`, then queues the `CreateRecord` + `AddChild` ops the sync engine
 * needs.
 *
 * Centralizes the temp-id / temp-edge choreography modules used to hand-roll
 * and diverge on — notably the `AddChild` edge `id`, which the engine needs to
 * drop the optimistic edge once the server assigns the real one. Copies that
 * omitted it leaked the `temp-edge:` placeholder into the cache.
 */
export function queueCreateChildRecord(args: QueueCreateChildRecordArgs): QueueCreateChildRecordResult {
  const { runtime, parentId } = args;
  const recordId = args.item.id ?? `temp:${crypto.randomUUID()}`;
  const edgeId = `temp-edge:${crypto.randomUUID()}`;
  const order = args.order ?? 0;
  const keyParent = args.keyParent ?? true;
  const item: Item = { ...args.item, id: recordId };

  runtime.cache.normalizeItem(optimisticCacheItemFromItem(item));
  runtime.cache.upsert_graph_child_of_edge(edgeId, recordId, parentId, order, keyParent);
  runtime.queueAndWake('CreateRecord', {
    ...item,
    is_temp: true,
    sync_status: 'pending'
  });
  runtime.queueAndWake('AddChild', {
    id: edgeId,
    parent: parentId,
    child: recordId,
    order,
    key_parent: keyParent
  });
  return { recordId, edgeId };
}

export interface QueueInventoryTransactionArgs {
  runtime: AppRuntime;
  stockItemId: string;
  label: string;
  delta: number;
  kind?: 'adjustment' | 'restock' | 'consumption';
  sourceRecordId?: string | null;
  note?: string | null;
}

export function queueInventoryTransaction(args: QueueInventoryTransactionArgs): string {
  const { runtime, stockItemId, label, delta, sourceRecordId, note } = args;
  const kind = args.kind ?? (delta >= 0 ? 'restock' : 'consumption');
  const item: Item = {
    id: `temp:${crypto.randomUUID()}`,
    text: label,
    // The delta is the single source of truth in the `quantity_delta`
    // additional (read by the server stock rollup); module_settings carries
    // only the bookkeeping fields.
    additionals: [buildQuantityDeltaAdditional(delta)],
    module_settings: {
      inventory_module: {
        stock_transaction: {
          // Record references live under the reserved refs object so the
          // sync engine's temp-id remap sees them (module-refs.ts).
          ...refsObject({ stock_item_id: stockItemId, source_record_id: sourceRecordId ?? null }),
          transacted_at: new Date().toISOString(),
          transaction_kind: kind,
          note: note ?? null
        }
      }
    }
  };

  return queueCreateChildRecord({ runtime, parentId: stockItemId, item }).recordId;
}
