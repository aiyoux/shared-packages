import type { AppRuntime } from '../sync/runtime.ts';
import { readComputedAdditional } from '../computed-additionals.ts';
import { readRef } from '../module-refs.ts';
import type { AdditionalWithId, Item } from '../types.ts';
import type { ScheduleCompilerContext, ProjectedOccurrence, StockSignal, ProjectionWindow, ProjectionQuery } from '../scheduler.ts';
import {
  inventoryModuleSettings,
  asFiniteNumber,
  asDate,
  normalizeRecordId,
  itemScopeIds,
  matchesScope,
  matchesWindow,
  stableHash,
  stringifyStable,
  computeOccurrenceId,
  computePriority,
  reminderRulesForItem
} from '../scheduler.ts';
import { DAY_MS, HOUR_MS } from '@modular-app/ui/date';

export interface InventoryStockItemConfig {
  reorder_point?: number | null;
  target_quantity?: number | null;
  base_unit?: string | null;
  consumption_rate_per_day?: number | null;
  depletion_days_remaining?: number | null;
  next_restock_at?: string | null;
  notify_days_before?: number[] | null;
  label?: string | null;
}

export interface InventoryStockTransactionConfig {
  stock_item_id?: string | null;
  // Legacy fallback only — the delta now lives in the `quantity_delta`
  // additional (the single source of truth the server stock rollup reads).
  quantity_delta?: number | null;
  transacted_at?: string | null;
  transaction_kind?: 'adjustment' | 'restock' | 'consumption';
  source_record_id?: string | null;
  note?: string | null;
}

// ── Stock as a pure-sum rollup ──────────────────────────────────────────────
// A stock item's quantity is the sum of its child transactions' deltas — there
// is no separate counted baseline. A physical recount is modelled as an
// `adjustment` transaction. The delta lives in a `quantity_delta` additional so
// the server can roll it up (see surql/.../inventory.surql), and the stock item
// carries a computed `stock_level` additional the server materializes.

export function buildQuantityDeltaAdditional(delta: number, id?: string): AdditionalWithId {
  return { id: id ?? crypto.randomUUID(), type: 'quantity_delta', delta } as unknown as AdditionalWithId;
}

/**
 * Authored rollup MARKER declaring the item a stock item: the server derives
 * the `stock_level` VALUE from descendant quantity_delta additionals into the
 * server-owned computed_additionals field (read via readComputedAdditional).
 */
export function buildStockLevelAdditional(id?: string): AdditionalWithId {
  return {
    id: id ?? crypto.randomUUID(),
    type: 'stock_level',
    mode: 'rollup'
  } as unknown as AdditionalWithId;
}

function recordTimestamp(item: Item): string | null {
  const raw = item as Item & { updated?: string | null; created?: string | null };
  return raw.updated ?? raw.created ?? null;
}

function quantityDeltaAdditional(item: Item): Record<string, unknown> | null {
  return (item.additionals?.find((additional) => (additional as any).type === 'quantity_delta') as
    Record<string, unknown> | undefined) ?? null;
}

function stockLevelAdditional(item: Item): Record<string, unknown> | null {
  return (readComputedAdditional(item, 'stock_level') as Record<string, unknown> | null) ?? null;
}

export interface InventoryStockTransaction {
  record_id: string;
  stock_item_id: string;
  quantity_delta: number;
  transacted_at: string;
  transaction_kind: 'adjustment' | 'restock' | 'consumption';
  source_record_id?: string | null;
  note?: string | null;
}

export interface InventoryDerivedStockState {
  item: Item;
  stock_item_id: string;
  label: string;
  base_unit?: string | null;
  current_quantity: number;
  /** Server-materialized stock level from the `stock_level` additional, if present. */
  computed_current_quantity?: number | null;
  counted_quantity: number;
  counted_at?: string | null;
  reorder_point?: number | null;
  target_quantity?: number | null;
  next_restock_at?: string | null;
  consumption_rate_per_day?: number | null;
  depletion_days_remaining?: number | null;
  transactions: InventoryStockTransaction[];
}

export function inventoryStockItemConfig(item: Item): InventoryStockItemConfig | null {
  const config = inventoryModuleSettings(item).stock_item;
  return config && typeof config === 'object'
    ? (config as InventoryStockItemConfig)
    : null;
}

export function inventoryTransactionConfig(item: Item): InventoryStockTransactionConfig | null {
  const config = inventoryModuleSettings(item).stock_transaction;
  if (!config || typeof config !== 'object') return null;
  // Record references live under the reserved refs object (module-refs.ts);
  // surface them flat so downstream logic keeps one shape.
  const ns = config as Record<string, unknown>;
  return {
    ...(ns as InventoryStockTransactionConfig),
    stock_item_id: readRef(ns, 'stock_item_id') ?? (ns.stock_item_id as string | null | undefined) ?? null,
    source_record_id: readRef(ns, 'source_record_id') ?? (ns.source_record_id as string | null | undefined) ?? null
  };
}

export function collectInventoryTransactionItems(
  stockItemId: string,
  items: Item[],
  runtime: AppRuntime | null | undefined
): Item[] {
  const wantedId = normalizeRecordId(stockItemId) ?? stockItemId;
  const out = new Map<string, Item>();

  if (runtime) {
    for (const edge of runtime.cache.get_children_for_parent(wantedId)) {
      const item = runtime.cache.getItem(edge.child_id) as Item | undefined;
      if (!item) continue;
      const config = inventoryTransactionConfig(item);
      if (!config) continue;
      const linkedId = normalizeRecordId(config.stock_item_id ?? null) ?? wantedId;
      if (linkedId !== wantedId) continue;
      out.set(String(item.id), item);
    }
  }

  for (const item of items) {
    const config = inventoryTransactionConfig(item);
    if (!config) continue;
    const linkedId = normalizeRecordId(config.stock_item_id ?? item.parent ?? null);
    if (linkedId !== wantedId) continue;
    out.set(String(item.id), item);
  }

  return [...out.values()];
}


export function normalizeInventoryTransaction(
  item: Item,
  fallbackStockItemId: string
): InventoryStockTransaction | null {
  const config = inventoryTransactionConfig(item);
  if (!config) return null;

  // The delta is canonical in the `quantity_delta` additional; config is a
  // lenient fallback for legacy/hand-built records.
  const additional = quantityDeltaAdditional(item);
  const quantityDelta = asFiniteNumber(additional?.delta ?? config.quantity_delta);
  const transactedAt = asDate(config.transacted_at ?? recordTimestamp(item));
  if (quantityDelta == null || !transactedAt) return null;

  return {
    record_id: String(item.id),
    stock_item_id:
      normalizeRecordId(config.stock_item_id ?? fallbackStockItemId) ?? fallbackStockItemId,
    quantity_delta: quantityDelta,
    transacted_at: transactedAt.toISOString(),
    transaction_kind:
      config.transaction_kind === 'adjustment' ||
      config.transaction_kind === 'restock' ||
      config.transaction_kind === 'consumption'
        ? config.transaction_kind
        : quantityDelta >= 0
          ? 'restock'
          : 'consumption',
    source_record_id: normalizeRecordId(config.source_record_id ?? null),
    note: typeof config.note === 'string' ? config.note : null
  };
}


export function deriveInventoryStockState(
  item: Item,
  items: Item[],
  context: ScheduleCompilerContext
): InventoryDerivedStockState | null {
  const stockItem = inventoryStockItemConfig(item);
  if (!stockItem) return null;

  const stockItemId = String(item.id);
  const transactions = collectInventoryTransactionItems(stockItemId, items, context.runtime)
    .map((transactionItem) => normalizeInventoryTransaction(transactionItem, stockItemId))
    .filter((transaction): transaction is InventoryStockTransaction => Boolean(transaction))
    .sort((left, right) =>
      left.transacted_at < right.transacted_at ? -1 : left.transacted_at > right.transacted_at ? 1 : 0
    );

  const reorderPoint = asFiniteNumber(stockItem.reorder_point ?? null);
  const targetQuantity = asFiniteNumber(stockItem.target_quantity ?? null);
  const consumptionRate = asFiniteNumber(stockItem.consumption_rate_per_day ?? null);
  const nextRestockAt = asDate(stockItem.next_restock_at ?? null);
  const baseUnit =
    typeof stockItem.base_unit === 'string' && stockItem.base_unit.trim().length > 0
      ? stockItem.base_unit.trim()
      : null;

  // Pure sum of all transaction deltas — no counted baseline or window. A
  // physical recount is an `adjustment` transaction, so the running total is
  // always the full history.
  const currentQuantity = transactions.reduce((sum, transaction) => sum + transaction.quantity_delta, 0);

  // The last `adjustment` transaction is the most recent physical recount.
  const lastAdjustment = [...transactions]
    .reverse()
    .find((transaction) => transaction.transaction_kind === 'adjustment');

  // Server-materialized stock level (present once inventory.surql is deployed);
  // the dashboard still trusts the client sum since it loads the transactions.
  const computedLevel = asFiniteNumber(stockLevelAdditional(item)?.current_quantity);

  const fallbackDepletion = asFiniteNumber(stockItem.depletion_days_remaining ?? null);
  const depletionDaysRemaining =
    consumptionRate && consumptionRate > 0
      ? Math.max(0, currentQuantity / consumptionRate)
      : fallbackDepletion;

  return {
    item,
    stock_item_id: stockItemId,
    label:
      typeof stockItem.label === 'string' && stockItem.label.trim().length > 0
        ? stockItem.label.trim()
        : item.text?.trim() || stockItemId,
    base_unit: baseUnit,
    current_quantity: currentQuantity,
    computed_current_quantity: computedLevel,
    counted_quantity: currentQuantity,
    counted_at: lastAdjustment?.transacted_at ?? null,
    reorder_point: reorderPoint,
    target_quantity: targetQuantity,
    next_restock_at: nextRestockAt?.toISOString() ?? null,
    consumption_rate_per_day: consumptionRate,
    depletion_days_remaining: depletionDaysRemaining,
    transactions
  };
}


const inventoryDerivedStockStateCollator = new Intl.Collator();

export function deriveInventoryStockStates(
  items: Item[],
  context: ScheduleCompilerContext
): InventoryDerivedStockState[] {
  return items
    .map((item) => deriveInventoryStockState(item, items, context))
    .filter((state): state is InventoryDerivedStockState => Boolean(state))
    .sort((left, right) => inventoryDerivedStockStateCollator.compare(left.label, right.label));
}


export function projectInventoryOccurrences(
  items: Item[],
  context: ScheduleCompilerContext
): ProjectedOccurrence[] {
  const out: ProjectedOccurrence[] = [];

  for (const state of deriveInventoryStockStates(items, context)) {
    const item = state.item;
    if (!matchesScope(item, context.query.scope_ids)) continue;

    const candidateSignals: Array<{ kind: StockSignal['signal_kind']; when: Date; detail: string }> = [];

    if (
      state.reorder_point != null &&
      Number.isFinite(state.current_quantity) &&
      state.current_quantity <= state.reorder_point
    ) {
      candidateSignals.push({
        kind: 'reorder',
        when: new Date(context.now),
        detail: `Stock is at ${state.current_quantity}${state.base_unit ? ` ${state.base_unit}` : ''}. Reorder point is ${state.reorder_point}${state.base_unit ? ` ${state.base_unit}` : ''}.`
      });
    }

    if (
      state.depletion_days_remaining != null &&
      Number.isFinite(state.depletion_days_remaining) &&
      state.depletion_days_remaining >= 0
    ) {
      candidateSignals.push({
        kind: 'depletion',
        when: new Date(context.now.getTime() + state.depletion_days_remaining * DAY_MS),
        detail: `Projected depletion in ${Math.ceil(state.depletion_days_remaining)} day${Math.ceil(state.depletion_days_remaining) === 1 ? '' : 's'}.`
      });
    }

    if (state.next_restock_at) {
      candidateSignals.push({
        kind: 'restock',
        when: new Date(state.next_restock_at),
        detail: state.target_quantity != null
          ? `Target stock ${state.target_quantity}${state.base_unit ? ` ${state.base_unit}` : ''}.`
          : 'Scheduled restock.'
      });
    }

    for (const signal of candidateSignals) {
      const endAt = new Date(signal.when.getTime() + HOUR_MS);
      if (!matchesWindow(signal.when, endAt, context.query.window)) continue;

      const versionKey = stableHash(
        stringifyStable({
          item_id: item.id,
          stock_item: inventoryStockItemConfig(item),
          signal_kind: signal.kind
        })
      );
      const occurrenceAnchor = signal.when.toISOString();
      const occurrenceId = computeOccurrenceId({
        sourceIdentity: String(item.id),
        occurrenceAnchor,
        compilerKey: 'inventory-stock',
        versionBoundary: versionKey
      });
      const stockSignalId = `stock:${stableHash(`${occurrenceId}|${signal.kind}`)}`;

      out.push({
        occurrence_id: occurrenceId,
        compiler_key: 'inventory-stock',
        source_kind: 'inventory-stock',
        source_record_id: String(item.id),
        source_template_id: null,
        scope_ids: itemScopeIds(item),
        start_at: signal.when.toISOString(),
        end_at: endAt.toISOString(),
        display_title: `${state.label} · ${signal.kind === 'depletion' ? 'Projected depletion' : signal.kind === 'reorder' ? 'Reorder' : 'Restock'}`,
        detail: signal.detail,
        priority: computePriority(signal.when, context.now) + 5,
        surface_tags: ['inventory', 'exec', 'reminders'],
        materialization_policy: 'project_only',
        stock_signal_id: stockSignalId,
        snapshot_hash: stableHash(
          stringifyStable({
            occurrence_id: occurrenceId,
            current_quantity: state.current_quantity,
            reorder_point: state.reorder_point,
            target_quantity: state.target_quantity,
            transactions: state.transactions.map((transaction) => ({
              id: transaction.record_id,
              quantity_delta: transaction.quantity_delta,
              transacted_at: transaction.transacted_at
            }))
          })
        ),
        source_version_key: versionKey,
        occurrence_anchor: occurrenceAnchor,
        reminder_rules: reminderRulesForItem(
          item,
          context.query,
          Array.isArray(inventoryStockItemConfig(item)?.notify_days_before)
            ? inventoryStockItemConfig(item)?.notify_days_before ?? null
            : null
        )
      });
    }
  }

  return out;
}
