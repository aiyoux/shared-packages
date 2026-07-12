import { describe, expect, it } from 'vitest';
import {
  adjustForQuietHours,
  buildReminderInstances,
  createOccurrenceSnapshot,
  isReminderPendingDelivery,
  projectOccurrences,
  upsertOccurrenceLedgerEntry,
  type ProjectedOccurrence
} from './scheduler.ts';

import {
  deriveInventoryStockStates,
  projectInventoryOccurrences
} from './scheduler/inventory.ts';

import {
  projectMedicationOccurrences
} from './scheduler/medication.ts';

import type { Item } from './types.ts';
import { HOUR_MS } from '@modular-app/ui/date';

function itemWithDate(id: string, iso: string): Item {
  const start = new Date(iso);
  return {
    id,
    text: `Item ${id}`,
    additionals: [
      {
        id: `${id}:date`,
        type: 'date',
        date_info: {
          is_status: false,
          value: {
            y: { s: { type: 'ba', v: start.getFullYear() } },
            m: { s: { type: 'ba', v: start.getMonth() + 1 } },
            d: { s: { type: 'ba', v: start.getDate() } },
            i: { s: { type: 'ba', v: start.getHours() * 60 + start.getMinutes() } }
          }
        }
      } as any
    ]
  };
}

function itemWithDateOnly(id: string, year: number, month: number, day: number): Item {
  return {
    id,
    text: `Item ${id}`,
    additionals: [
      {
        id: `${id}:date`,
        type: 'date',
        date_info: {
          is_status: false,
          value: {
            y: { s: { type: 'ba', v: year } },
            m: { s: { type: 'ba', v: month } },
            d: { s: { type: 'ba', v: day } }
          }
        }
      } as any
    ]
  };
}

describe('scheduler projection', () => {
	  it('keeps occurrence identity stable for untouched future projections', () => {
	    const now = new Date('2026-04-22T10:00:00.000Z');
	    const items = [itemWithDate('records:a', '2026-04-24T09:00:00.000Z')];
	    const first = projectOccurrences(items, { now });
	    const second = projectOccurrences(items, { now: new Date('2026-04-22T11:15:00.000Z') });
	    expect(first[0]?.occurrence_id).toBe(second[0]?.occurrence_id);
	  });

	  it('projects date-only records as whole-day occurrences', () => {
	    const now = new Date(2026, 3, 22, 12, 0, 0, 0);
	    const [occurrence] = projectOccurrences(
	      [itemWithDateOnly('records:day', 2026, 4, 22)],
	      { now }
	    );

	    expect(occurrence?.date_scope_kind).toBe('day');
	    expect(occurrence?.start_at).toBe(new Date(2026, 3, 22, 0, 0, 0, 0).toISOString());
	    expect(occurrence?.end_at).toBe(new Date(2026, 3, 23, 0, 0, 0, 0).toISOString());
	  });

  it('freezes touched occurrence snapshots in the ledger', () => {
    const occurrence: ProjectedOccurrence = {
      occurrence_id: 'occ:1',
      compiler_key: 'generic-date',
      source_kind: 'record-date',
      source_record_id: 'records:a',
      source_template_id: null,
      scope_ids: null,
      start_at: '2026-04-24T09:00:00.000Z',
      end_at: '2026-04-24T10:00:00.000Z',
      display_title: 'Item A',
      detail: undefined,
      priority: 80,
      surface_tags: ['exec'],
      materialization_policy: 'project_only',
      stock_signal_id: null,
      snapshot_hash: 'snap-v1',
      source_version_key: 'ver-v1',
      occurrence_anchor: '2026-04-24T09:00:00.000Z',
      reminder_rules: []
    };

    const entry = upsertOccurrenceLedgerEntry(undefined, occurrence, {
      acknowledged_at: '2026-04-22T10:05:00.000Z'
    });

    const editedOccurrence = {
      ...occurrence,
      start_at: '2026-04-25T09:00:00.000Z',
      snapshot_hash: 'snap-v2',
      source_version_key: 'ver-v2'
    };

    expect(entry.frozen_start_at).toBe('2026-04-24T09:00:00.000Z');
    expect(entry.snapshot_hash).toBe('snap-v1');
    expect(createOccurrenceSnapshot(editedOccurrence).snapshot_hash).toBe('snap-v2');
  });

  it('delays browser reminders into quiet hours without suppressing in-app reminders', () => {
    const localStart = new Date(2026, 3, 22, 21, 0, 0, 0);
    const occurrence: ProjectedOccurrence = {
      occurrence_id: 'occ:2',
      compiler_key: 'generic-date',
      source_kind: 'record-date',
      source_record_id: 'records:b',
      source_template_id: null,
      scope_ids: null,
      start_at: localStart.toISOString(),
      end_at: new Date(localStart.getTime() + HOUR_MS).toISOString(),
      display_title: 'Quiet reminder',
      detail: undefined,
      priority: 60,
      surface_tags: ['reminders'],
      materialization_policy: 'project_only',
      stock_signal_id: null,
      snapshot_hash: 'snap',
      source_version_key: 'ver',
      occurrence_anchor: localStart.toISOString(),
      reminder_rules: [
        {
          key: 'due',
          label: 'Due now',
          lead_minutes: 0,
          channels: ['in_app', 'browser']
        }
      ]
    };

    const reminders = buildReminderInstances(
      [occurrence],
      {
        now: new Date(2026, 3, 22, 21, 5, 0, 0),
        quiet_hours: { start: '20:00', end: '08:00' }
      },
      {}
    );

    const inApp = reminders.find((entry) => entry.channel === 'in_app');
    const browser = reminders.find((entry) => entry.channel === 'browser');
    const browserDeliverAt = browser ? new Date(browser.deliver_at) : null;

    expect(inApp?.deliver_at).toBe(localStart.toISOString());
    expect(browser?.is_quiet_hours_delayed).toBe(true);
    expect(browserDeliverAt?.getHours()).toBe(8);
    expect(browserDeliverAt?.getMinutes()).toBe(0);
    expect(browserDeliverAt?.getDate()).toBe(localStart.getDate() + 1);
  });

  it('only treats pending and snoozed due reminders as delivery candidates', () => {
    expect(
      isReminderPendingDelivery({
        reminder_instance_id: 'rem:pending',
        occurrence_id: 'occ:pending',
        rule_key: 'due',
        channel: 'web_push',
        display_title: 'Pending',
        source_kind: 'record-date',
        source_record_id: 'records:a',
        deliver_at: '2026-04-22T00:00:00.000Z',
        due_at: '2026-04-22T00:00:00.000Z',
        state: 'pending',
        is_due: true,
        is_quiet_hours_delayed: false
      })
    ).toBe(true);
    expect(
      isReminderPendingDelivery({
        reminder_instance_id: 'rem:snoozed',
        occurrence_id: 'occ:snoozed',
        rule_key: 'due',
        channel: 'web_push',
        display_title: 'Snoozed',
        source_kind: 'record-date',
        source_record_id: 'records:b',
        deliver_at: '2026-04-22T00:00:00.000Z',
        due_at: '2026-04-22T01:00:00.000Z',
        state: 'snoozed',
        is_due: true,
        is_quiet_hours_delayed: false
      })
    ).toBe(true);
    expect(
      isReminderPendingDelivery({
        reminder_instance_id: 'rem:delivered',
        occurrence_id: 'occ:delivered',
        rule_key: 'due',
        channel: 'web_push',
        display_title: 'Delivered',
        source_kind: 'record-date',
        source_record_id: 'records:c',
        deliver_at: '2026-04-22T00:00:00.000Z',
        due_at: '2026-04-22T00:00:00.000Z',
        state: 'delivered',
        is_due: true,
        is_quiet_hours_delayed: false
      })
    ).toBe(false);
    expect(
      isReminderPendingDelivery({
        reminder_instance_id: 'rem:future',
        occurrence_id: 'occ:future',
        rule_key: 'due',
        channel: 'web_push',
        display_title: 'Future',
        source_kind: 'record-date',
        source_record_id: 'records:d',
        deliver_at: '2026-04-23T00:00:00.000Z',
        due_at: '2026-04-23T00:00:00.000Z',
        state: 'pending',
        is_due: false,
        is_quiet_hours_delayed: false
      })
    ).toBe(false);
  });

  it('projects inventory reorder and depletion occurrences deterministically', () => {
    const now = new Date('2026-04-22T00:00:00.000Z');
    const occurrences = projectInventoryOccurrences(
      [
        {
          id: 'records:stock-a',
          text: 'Medication stock',
          module_settings: {
            inventory_module: {
              stock_item: {
                current_quantity: 2,
                reorder_point: 4,
                depletion_days_remaining: 3
              }
            }
          }
        }
      ],
      { now, query: { now } }
    );

    expect(occurrences.map((entry) => entry.source_kind)).toEqual([
      'inventory-stock',
      'inventory-stock'
    ]);
    expect(occurrences[0]?.start_at).toBe('2026-04-22T00:00:00.000Z');
    expect(occurrences[1]?.start_at).toBe('2026-04-25T00:00:00.000Z');
  });

  it('derives inventory current quantity as a pure sum of transaction-delta additionals', () => {
    const now = new Date('2026-04-22T00:00:00.000Z');
    const states = deriveInventoryStockStates(
      [
        {
          id: 'records:stock-a',
          text: 'Medication stock',
          module_settings: {
            inventory_module: {
              stock_item: {
                consumption_rate_per_day: 2,
                reorder_point: 4
              }
            }
          }
        },
        {
          // Initial count modelled as an adjustment transaction (path b).
          id: 'records:tx-initial',
          text: 'Recount to 10',
          additionals: [{ id: 'd0', type: 'quantity_delta', delta: 10 } as any],
          module_settings: {
            inventory_module: {
              stock_transaction: {
                stock_item_id: 'records:stock-a',
                transacted_at: '2026-04-20T00:00:00.000Z',
                transaction_kind: 'adjustment'
              }
            }
          }
        },
        {
          id: 'records:tx-restock',
          text: 'Restock',
          additionals: [{ id: 'd1', type: 'quantity_delta', delta: 3 } as any],
          module_settings: {
            inventory_module: {
              stock_transaction: {
                stock_item_id: 'records:stock-a',
                transacted_at: '2026-04-21T00:00:00.000Z',
                transaction_kind: 'restock'
              }
            }
          }
        },
        {
          id: 'records:tx-consume',
          text: 'Consume',
          additionals: [{ id: 'd2', type: 'quantity_delta', delta: -2 } as any],
          module_settings: {
            inventory_module: {
              stock_transaction: {
                stock_item_id: 'records:stock-a',
                transacted_at: '2026-04-21T12:00:00.000Z',
                transaction_kind: 'consumption'
              }
            }
          }
        }
      ],
      { now, query: { now } }
    );

    expect(states).toHaveLength(1);
    expect(states[0]?.current_quantity).toBe(11);
    expect(states[0]?.depletion_days_remaining).toBe(5.5);
    expect(states[0]?.transactions).toHaveLength(3);
    // counted_at reflects the most recent adjustment (the recount).
    expect(states[0]?.counted_at).toBe('2026-04-20T00:00:00.000Z');
  });

  it('projects medication doctor-request and pickup occurrences from inventory-backed stock', () => {
    const now = new Date('2026-04-22T00:00:00.000Z');
    const occurrences = projectMedicationOccurrences(
      [
        {
          id: 'records:stock-med',
          text: 'Medication stock',
          module_settings: {
            inventory_module: {
              stock_item: {}
            }
          }
        },
        {
          // 14 units on hand, modelled as an adjustment transaction (path b).
          id: 'records:stock-med-count',
          text: 'Recount to 14',
          parent: 'records:stock-med',
          additionals: [{ id: 'dm', type: 'quantity_delta', delta: 14 } as any],
          module_settings: {
            inventory_module: {
              stock_transaction: {
                stock_item_id: 'records:stock-med',
                transacted_at: '2026-04-22T00:00:00.000Z',
                transaction_kind: 'adjustment'
              }
            }
          }
        },
        {
          id: 'records:med-a',
          text: 'Dexamphetamine',
          module_settings: {
            medication_module: {
              medication: {
                inventory_stock_item_id: 'records:stock-med',
                effective_units_per_day: 2,
                safety_buffer_days: 2,
                doctor_lead_days: 3,
                pharmacy_lead_days: 1
              }
            }
          }
        }
      ],
      { now, query: { now } }
    );

    expect(occurrences.map((entry) => entry.display_title)).toEqual([
      'Dexamphetamine · Request script',
      'Dexamphetamine · Pickup medication'
    ]);
    expect(occurrences[0]?.source_kind).toBe('medication');
    expect(occurrences[0]?.start_at).toBe('2026-04-23T00:00:00.000Z');
    expect(occurrences[1]?.start_at).toBe('2026-04-26T00:00:00.000Z');
  });
});

describe('quiet-hours helper', () => {
  it('rolls nighttime deliveries to the next quiet-hours end', () => {
    const lateNight = new Date(2026, 3, 22, 23, 30, 0, 0);
    const adjusted = adjustForQuietHours(
      lateNight,
      { start: '20:00', end: '08:00' }
    );
    expect(adjusted.delayed).toBe(true);
    expect(adjusted.deliverAt.getHours()).toBe(8);
    expect(adjusted.deliverAt.getMinutes()).toBe(0);
    expect(adjusted.deliverAt.getDate()).toBe(lateNight.getDate() + 1);
  });
});
