import type { Item } from '../types.ts';
import { readRef } from '../module-refs.ts';
import type { ScheduleCompilerContext, ProjectedOccurrence, ProjectionQuery, ProjectionWindow } from '../scheduler.ts';
import {
  medicationModuleSettings,
  normalizeRecordId,
  asDate,
  asFiniteNumber,
  matchesWindow,
  stableHash,
  stringifyStable,
  computeOccurrenceId,
  computePriority,
  reminderRulesForItem,
  itemScopeIds
} from '../scheduler.ts';
import { DAY_MS, HOUR_MS } from '@modular-app/ui/date';
import { deriveInventoryStockStates, type InventoryDerivedStockState } from './inventory.ts';

export interface MedicationScheduleConfig {
  inventory_stock_item_id?: string | null;
  current_units_on_hand?: number | null;
  prescribed_units_per_day?: number | null;
  effective_units_per_day?: number | null;
  safety_buffer_days?: number | null;
  doctor_lead_days?: number | null;
  pharmacy_lead_days?: number | null;
  notify_days_before?: {
    doctor?: number[] | null;
    pickup?: number[] | null;
  } | null;
  combine_group?: string | null;
  next_review_at?: string | null;
  active?: boolean | null;
}

export interface MedicationDerivedState {
  item: Item;
  label: string;
  stock_item_id?: string | null;
  stock_label?: string | null;
  linked_stock?: InventoryDerivedStockState | null;
  units_on_hand: number;
  units_per_day: number;
  safety_buffer_days: number;
  doctor_lead_days: number;
  pharmacy_lead_days: number;
  depletion_at: string;
  pickup_at: string;
  doctor_request_at: string;
  combine_group?: string | null;
  next_review_at?: string | null;
  notify_days_before?: MedicationScheduleConfig['notify_days_before'];
}

export function deriveMedicationStates(
  items: Item[],
  context: ScheduleCompilerContext
): MedicationDerivedState[] {
  const stockStates = new Map(
    deriveInventoryStockStates(items, context).map((state) => [state.stock_item_id, state])
  );
  const out: MedicationDerivedState[] = [];

  for (const item of items) {
      const medication = medicationModuleSettings(item).medication;
      if (!medication || typeof medication !== 'object') continue;
      const config = medication as MedicationScheduleConfig & Record<string, unknown>;
      if (config.active === false) continue;

      // Record references live under the reserved refs object (module-refs.ts).
      const linkedStockId = normalizeRecordId(readRef(config, 'inventory_stock_item_id') ?? config.inventory_stock_item_id ?? null);
      const linkedStock = linkedStockId ? stockStates.get(linkedStockId) : null;
      const unitsOnHand =
        linkedStock?.current_quantity ?? asFiniteNumber(config.current_units_on_hand ?? null);
      const unitsPerDay =
        asFiniteNumber(config.effective_units_per_day ?? config.prescribed_units_per_day ?? null) ??
        0;
      if (!Number.isFinite(unitsOnHand) || unitsOnHand == null || unitsPerDay <= 0) continue;

      const safetyBufferDays = asFiniteNumber(config.safety_buffer_days ?? null) ?? 0;
      const doctorLeadDays = asFiniteNumber(config.doctor_lead_days ?? null) ?? 0;
      const pharmacyLeadDays = asFiniteNumber(config.pharmacy_lead_days ?? null) ?? 0;
      const depletionAt = new Date(context.now.getTime() + (unitsOnHand / unitsPerDay) * DAY_MS);
      const pickupAt = new Date(
        depletionAt.getTime() - (safetyBufferDays + pharmacyLeadDays) * DAY_MS
      );
      const doctorAt = new Date(pickupAt.getTime() - doctorLeadDays * DAY_MS);

      out.push({
        item,
        label: item.text?.trim() || String(item.id),
        stock_item_id: linkedStockId ?? null,
        stock_label: linkedStock?.label ?? null,
        linked_stock: linkedStock ?? null,
        units_on_hand: unitsOnHand,
        units_per_day: unitsPerDay,
        safety_buffer_days: safetyBufferDays,
        doctor_lead_days: doctorLeadDays,
        pharmacy_lead_days: pharmacyLeadDays,
        depletion_at: depletionAt.toISOString(),
        pickup_at: pickupAt.toISOString(),
        doctor_request_at: doctorAt.toISOString(),
        combine_group:
          typeof config.combine_group === 'string' && config.combine_group.trim().length > 0
            ? config.combine_group.trim()
            : null,
        next_review_at: asDate(config.next_review_at ?? null)?.toISOString() ?? null,
        notify_days_before: config.notify_days_before ?? null
      });
  }

  return out.sort((left, right) =>
    left.pickup_at < right.pickup_at ? -1 : left.pickup_at > right.pickup_at ? 1 : 0
  );
}


const dateFormatter = new Intl.DateTimeFormat();

export function projectMedicationOccurrences(
  items: Item[],
  context: ScheduleCompilerContext
): ProjectedOccurrence[] {
  const out: ProjectedOccurrence[] = [];
  for (const state of deriveMedicationStates(items, context)) {
    const item = state.item;
    const occurrences = [
      {
        kind: 'doctor-request',
        at: new Date(state.doctor_request_at),
        title: `${state.label} · Request script`,
        detail: `Allow ${state.doctor_lead_days} day${state.doctor_lead_days === 1 ? '' : 's'} for the doctor and ${state.pharmacy_lead_days} day${state.pharmacy_lead_days === 1 ? '' : 's'} for pickup with a ${state.safety_buffer_days}-day safety buffer.`,
        extraLeadDays: state.notify_days_before?.doctor ?? null
      },
      {
        kind: 'pickup',
        at: new Date(state.pickup_at),
        title: `${state.label} · Pickup medication`,
        detail: `Projected stock depletion at ${dateFormatter.format(new Date(state.depletion_at))}.`,
        extraLeadDays: state.notify_days_before?.pickup ?? null
      }
    ];

    for (const definition of occurrences) {
      const endAt = new Date(definition.at.getTime() + HOUR_MS);
      if (!matchesWindow(definition.at, endAt, context.query.window)) continue;

      const versionKey = stableHash(
        stringifyStable({
          item_id: item.id,
          medication: medicationModuleSettings(item).medication,
          linked_stock: state.linked_stock
            ? {
                stock_item_id: state.linked_stock.stock_item_id,
                current_quantity: state.linked_stock.current_quantity,
                counted_at: state.linked_stock.counted_at,
                transactions: state.linked_stock.transactions.map((transaction) => ({
                  id: transaction.record_id,
                  quantity_delta: transaction.quantity_delta,
                  transacted_at: transaction.transacted_at
                }))
              }
            : null,
          occurrence_kind: definition.kind
        })
      );
      const occurrenceAnchor = definition.at.toISOString();
      const occurrenceId = computeOccurrenceId({
        sourceIdentity: String(item.id),
        occurrenceAnchor,
        compilerKey: 'medication-schedule',
        versionBoundary: `${versionKey}:${definition.kind}`
      });

      out.push({
        occurrence_id: occurrenceId,
        compiler_key: 'medication-schedule',
        source_kind: 'medication',
        source_record_id: String(item.id),
        source_template_id: null,
        scope_ids: itemScopeIds(item),
        start_at: definition.at.toISOString(),
        end_at: endAt.toISOString(),
        display_title: definition.title,
        detail: definition.detail,
        priority: computePriority(definition.at, context.now) + 10,
        surface_tags: ['medication', 'exec', 'planner', 'reminders'],
        materialization_policy: 'project_only',
        stock_signal_id: state.linked_stock?.stock_item_id ?? null,
        snapshot_hash: stableHash(
          stringifyStable({
            occurrence_id: occurrenceId,
            units_on_hand: state.units_on_hand,
            units_per_day: state.units_per_day,
            safety_buffer_days: state.safety_buffer_days,
            doctor_lead_days: state.doctor_lead_days,
            pharmacy_lead_days: state.pharmacy_lead_days
          })
        ),
        source_version_key: versionKey,
        occurrence_anchor: occurrenceAnchor,
        reminder_rules: reminderRulesForItem(item, context.query, definition.extraLeadDays)
      });
    }
  }

  return out;
}
