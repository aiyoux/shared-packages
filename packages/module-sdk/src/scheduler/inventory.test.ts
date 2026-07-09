import { describe, expect, it } from 'vitest';
import {
  buildQuantityDeltaAdditional,
  buildStockLevelAdditional,
  deriveInventoryStockStates
} from './inventory.ts';
import type { Item } from '../types.ts';

// Mirrors of the server-side stock-rollup predicates in
// surql/runtime/progress_calculation/modules/inventory.surql. The server sums a
// child's `quantity_delta` additional into the parent's computed `stock_level`
// additional only when both pass these predicates — so these lock the client
// emission to that contract.
function serverAcceptsQuantityDelta(qd: any): boolean {
  return Boolean(qd) && qd.type === 'quantity_delta' && typeof qd.delta === 'number';
}
// Mirrors fn::has_computed_stock_level: the authored opt-in is a
// `mode: 'rollup'` MARKER (the computed VALUE lives server-side in
// computed_additionals and is never client-emitted).
function serverAcceptsStockLevelMarker(sl: any): boolean {
  return Boolean(sl) && sl.type === 'stock_level' && sl.mode === 'rollup';
}

const ctx = { now: new Date('2026-04-22T00:00:00.000Z'), query: { now: new Date('2026-04-22T00:00:00.000Z') } } as any;

function stockItem(id: string, config: Record<string, unknown> = {}): Item {
  return { id, text: 'Stock', module_settings: { inventory_module: { stock_item: config } } } as any;
}
function tx(id: string, stockId: string, delta: number, kind = 'restock', at = '2026-04-21T00:00:00.000Z'): Item {
  return {
    id,
    text: 'Txn',
    additionals: [buildQuantityDeltaAdditional(delta, `d-${id}`)] as any,
    module_settings: {
      inventory_module: { stock_transaction: { stock_item_id: stockId, transacted_at: at, transaction_kind: kind } }
    }
  } as any;
}

describe('inventory ⇄ server stock-rollup contract', () => {
  it('emits quantity_delta values and a stock_level rollup marker the server accepts', () => {
    expect(serverAcceptsQuantityDelta(buildQuantityDeltaAdditional(5))).toBe(true);
    expect(serverAcceptsQuantityDelta(buildQuantityDeltaAdditional(-2.5))).toBe(true);
    const marker = buildStockLevelAdditional();
    expect(serverAcceptsStockLevelMarker(marker)).toBe(true);
    // Never a value, never computed — those are server-owned.
    expect((marker as any).computed).toBeUndefined();
    expect((marker as any).current_quantity).toBeUndefined();
  });

  it('rejects malformed additionals (guards against silent rollup breakage)', () => {
    expect(serverAcceptsQuantityDelta({ type: 'quantity_delta', delta: 'lots' })).toBe(false);
    expect(serverAcceptsQuantityDelta({ type: 'stock_level', delta: 1 })).toBe(false);
    expect(serverAcceptsStockLevelMarker({ type: 'stock_level', computed: true, current_quantity: 3 })).toBe(false);
  });
});

describe('inventory pure-sum derivation (path b)', () => {
  it('sums transaction-delta additionals with no baseline', () => {
    const items = [
      stockItem('records:s', { base_unit: 'unit', consumption_rate_per_day: 2 }),
      tx('records:t1', 'records:s', 10, 'adjustment', '2026-04-20T00:00:00.000Z'),
      tx('records:t2', 'records:s', 3, 'restock'),
      tx('records:t3', 'records:s', -2, 'consumption', '2026-04-21T12:00:00.000Z')
    ];
    const [state] = deriveInventoryStockStates(items, ctx);
    expect(state?.current_quantity).toBe(11);
    expect(state?.counted_quantity).toBe(11);
    expect(state?.transactions).toHaveLength(3);
    // counted_at reflects the most recent adjustment (the recount).
    expect(state?.counted_at).toBe('2026-04-20T00:00:00.000Z');
  });

  it('treats a recount as the adjustment delta that reaches the target', () => {
    // Current 4 (one +4 restock); a recount to 10 is a +6 adjustment.
    const items = [
      stockItem('records:s'),
      tx('records:t1', 'records:s', 4, 'restock'),
      tx('records:t2', 'records:s', 10 - 4, 'adjustment', '2026-04-22T00:00:00.000Z')
    ];
    const [state] = deriveInventoryStockStates(items, ctx);
    expect(state?.current_quantity).toBe(10);
  });

  it('reads the server-materialized stock_level as a cross-check', () => {
    const stock = stockItem('records:s');
    (stock as any).additionals = [buildStockLevelAdditional()];
    (stock as any).computed_additionals = [
      { id: 'sl-1', type: 'stock_level', current_quantity: 42, computed: true }
    ];
    const [state] = deriveInventoryStockStates([stock, tx('records:t1', 'records:s', 7)], ctx);
    // Client sum stays authoritative (transactions are loaded); the materialized
    // value is surfaced separately for rollup-only consumers.
    expect(state?.current_quantity).toBe(7);
    expect(state?.computed_current_quantity).toBe(42);
  });
});
