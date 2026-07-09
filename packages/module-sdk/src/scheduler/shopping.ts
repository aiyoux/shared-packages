import type { AppRuntime } from '../sync/runtime.ts';
import { readRef, readRefList } from '../module-refs.ts';
import type { Item } from '../types.ts';
import { asDate, asFiniteNumber, normalizeCurrency, normalizeRecordId } from '../scheduler.ts';

export type ShoppingListStatus = 'draft' | 'active' | 'shopping' | 'completed' | 'archived';
export type ShoppingSourceMode = 'date_range' | 'selected' | 'manual' | 'mixed';
export type ShoppingLineStatus = 'needed' | 'checked' | 'purchased' | 'skipped';
export type ShoppingItemKind = 'food' | 'recipe_ingredient' | 'inventory' | 'medication' | 'generic';
export type ShoppingPurchaseMode = 'restock_inventory' | 'purchase_only';
export type ShoppingUnitFamily = 'mass' | 'volume' | 'count';

export interface ShoppingQuantity {
  value: number;
  unit: string;
  unit_family: ShoppingUnitFamily | string;
}

export interface ShoppingListConfig {
  status?: ShoppingListStatus | string | null;
  source_mode?: ShoppingSourceMode | string | null;
  start_date?: string | null;
  end_date?: string | null;
  generated_at?: string | null;
  completed_at?: string | null;
}

export interface ShoppingLineItemConfig {
  list_id?: string | null;
  status?: ShoppingLineStatus | string | null;
  item_kind?: ShoppingItemKind | string | null;
  label?: string | null;
  quantity?: ShoppingQuantity | null;
  inventory_stock_item_id?: string | null;
  medication_record_id?: string | null;
  food_template_id?: string | null;
  recipe_id?: string | null;
  source_record_ids?: string[] | null;
  purchase_mode?: ShoppingPurchaseMode | string | null;
  amount_minor?: number | null;
  currency?: string | null;
  inventory_transaction_id?: string | null;
  purchased_at?: string | null;
  warning_state?: string | null;
}

export interface ShoppingLineItemState {
  item: Item;
  line_item_id: string;
  list_id: string | null;
  status: ShoppingLineStatus;
  item_kind: ShoppingItemKind;
  label: string;
  quantity: ShoppingQuantity | null;
  inventory_stock_item_id: string | null;
  medication_record_id: string | null;
  food_template_id: string | null;
  recipe_id: string | null;
  source_record_ids: string[];
  purchase_mode: ShoppingPurchaseMode;
  amount_minor: number | null;
  currency: string | null;
  inventory_transaction_id: string | null;
  purchased_at: string | null;
  warning_state: string | null;
}

export interface ShoppingListState {
  item: Item;
  list_id: string;
  label: string;
  status: ShoppingListStatus;
  source_mode: ShoppingSourceMode;
  start_date: string | null;
  end_date: string | null;
  generated_at: string | null;
  completed_at: string | null;
  lines: ShoppingLineItemState[];
}

export function shoppingModuleSettings(item: Item): Record<string, unknown> {
  return (item.module_settings?.shopping_module ?? {}) as Record<string, unknown>;
}

export function shoppingListConfig(item: Item): ShoppingListConfig | null {
  const value = shoppingModuleSettings(item).list;
  return value && typeof value === 'object' ? (value as ShoppingListConfig) : null;
}

export function shoppingLineItemConfig(item: Item): ShoppingLineItemConfig | null {
  const value = shoppingModuleSettings(item).line_item;
  if (!value || typeof value !== 'object') return null;
  // Record references live under the reserved refs object (module-refs.ts);
  // surface them flat so downstream logic keeps one shape.
  const ns = value as Record<string, unknown>;
  const flat = (key: string) => (ns[key] as string | null | undefined) ?? null;
  return {
    ...(ns as ShoppingLineItemConfig),
    list_id: readRef(ns, 'list_id') ?? flat('list_id'),
    inventory_stock_item_id: readRef(ns, 'inventory_stock_item_id') ?? flat('inventory_stock_item_id'),
    medication_record_id: readRef(ns, 'medication_record_id') ?? flat('medication_record_id'),
    food_template_id: readRef(ns, 'food_template_id') ?? flat('food_template_id'),
    recipe_id: readRef(ns, 'recipe_id') ?? flat('recipe_id'),
    inventory_transaction_id: readRef(ns, 'inventory_transaction_id') ?? flat('inventory_transaction_id'),
    source_record_ids: readRefList(ns, 'source_record_ids').length > 0
      ? readRefList(ns, 'source_record_ids')
      : (Array.isArray(ns.source_record_ids) ? (ns.source_record_ids as string[]) : [])
  };
}

function normalizeListStatus(value: unknown): ShoppingListStatus {
  return value === 'draft' || value === 'active' || value === 'shopping' || value === 'completed' || value === 'archived'
    ? value
    : 'active';
}

function normalizeSourceMode(value: unknown): ShoppingSourceMode {
  return value === 'date_range' || value === 'selected' || value === 'manual' || value === 'mixed'
    ? value
    : 'manual';
}

function normalizeLineStatus(value: unknown): ShoppingLineStatus {
  return value === 'needed' || value === 'checked' || value === 'purchased' || value === 'skipped'
    ? value
    : 'needed';
}

function normalizeItemKind(value: unknown): ShoppingItemKind {
  return value === 'food' || value === 'recipe_ingredient' || value === 'inventory' || value === 'medication' || value === 'generic'
    ? value
    : 'generic';
}

function normalizePurchaseMode(value: unknown, stockItemId: string | null): ShoppingPurchaseMode {
  if (value === 'purchase_only' || value === 'restock_inventory') return value;
  return stockItemId ? 'restock_inventory' : 'purchase_only';
}

function normalizeQuantity(value: unknown): ShoppingQuantity | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const parsed = asFiniteNumber(raw.value);
  const unit = typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : 'unit';
  const unitFamily = typeof raw.unit_family === 'string' && raw.unit_family.trim()
    ? raw.unit_family.trim()
    : 'count';
  if (parsed == null || parsed <= 0) return null;
  return { value: parsed, unit, unit_family: unitFamily };
}

function lineStateFromItem(item: Item): ShoppingLineItemState | null {
  const config = shoppingLineItemConfig(item);
  if (!config) return null;
  const stockItemId = normalizeRecordId(config.inventory_stock_item_id ?? null);
  const quantity = normalizeQuantity(config.quantity);
  const amountMinor = asFiniteNumber(config.amount_minor);
  return {
    item,
    line_item_id: String(item.id),
    list_id: normalizeRecordId(config.list_id ?? item.parent ?? null),
    status: normalizeLineStatus(config.status),
    item_kind: normalizeItemKind(config.item_kind),
    label: config.label?.trim() || item.text?.trim() || String(item.id),
    quantity,
    inventory_stock_item_id: stockItemId,
    medication_record_id: normalizeRecordId(config.medication_record_id ?? null),
    food_template_id: normalizeRecordId(config.food_template_id ?? null),
    recipe_id: normalizeRecordId(config.recipe_id ?? null),
    source_record_ids: Array.isArray(config.source_record_ids)
      ? config.source_record_ids.map((id) => normalizeRecordId(String(id))).filter((id): id is string => Boolean(id))
      : [],
    purchase_mode: normalizePurchaseMode(config.purchase_mode, stockItemId),
    amount_minor: amountMinor != null && amountMinor >= 0 ? Math.round(amountMinor) : null,
    currency: normalizeCurrency(config.currency),
    inventory_transaction_id: normalizeRecordId(config.inventory_transaction_id ?? null),
    purchased_at: asDate(config.purchased_at ?? null)?.toISOString() ?? null,
    warning_state: typeof config.warning_state === 'string' ? config.warning_state : null
  };
}

export function deriveShoppingListStates(
  items: Item[],
  runtime: AppRuntime | null | undefined
): ShoppingListState[] {
  const linesByList = new Map<string, ShoppingLineItemState[]>();
  const looseLines: ShoppingLineItemState[] = [];

  for (const item of items) {
    const line = lineStateFromItem(item);
    if (!line) continue;
    if (line.list_id) {
      const existing = linesByList.get(line.list_id) ?? [];
      existing.push(line);
      linesByList.set(line.list_id, existing);
    } else {
      looseLines.push(line);
    }
  }

  if (runtime) {
    for (const [listId, lines] of [...linesByList]) {
      for (const edge of runtime.cache.get_children_for_parent(listId)) {
        const item = runtime.cache.getItem(edge.child_id) as Item | undefined;
        if (!item) continue;
        const line = lineStateFromItem(item);
        if (!line) continue;
        if (!lines.some((existing) => existing.line_item_id === line.line_item_id)) {
          lines.push(line);
        }
      }
    }
  }

  const lists: ShoppingListState[] = [];
  for (const item of items) {
    const config = shoppingListConfig(item);
    if (!config) continue;
    const listId = String(item.id);
    const lines = (linesByList.get(listId) ?? [])
      .sort((left, right) => left.label.localeCompare(right.label));
    lists.push({
      item,
      list_id: listId,
      label: item.text?.trim() || listId,
      status: normalizeListStatus(config.status),
      source_mode: normalizeSourceMode(config.source_mode),
      start_date: asDate(config.start_date ?? null)?.toISOString() ?? null,
      end_date: asDate(config.end_date ?? null)?.toISOString() ?? null,
      generated_at: asDate(config.generated_at ?? null)?.toISOString() ?? null,
      completed_at: asDate(config.completed_at ?? null)?.toISOString() ?? null,
      lines
    });
  }

  if (looseLines.length > 0) {
    lists.push({
      item: {
        id: 'virtual:shopping-loose-lines',
        text: 'Loose shopping items'
      },
      list_id: 'virtual:shopping-loose-lines',
      label: 'Loose shopping items',
      status: 'active',
      source_mode: 'manual',
      start_date: null,
      end_date: null,
      generated_at: null,
      completed_at: null,
      lines: looseLines
    });
  }

  return lists.sort((left, right) => {
    const leftActive = left.status === 'active' || left.status === 'shopping';
    const rightActive = right.status === 'active' || right.status === 'shopping';
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}
