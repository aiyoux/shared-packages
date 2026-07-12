import type { AppRuntime } from './sync/runtime.ts';
import type { Item } from './types.ts';
import { getDateAdditionalData, isDateAdditional } from './date-additional.ts';
import { resolveTimeWindow, type DateScopeKind } from '@modular-app/ui/date';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@modular-app/ui/date';

import {
  deriveInventoryStockState,
  deriveInventoryStockStates,
  projectInventoryOccurrences,
  type InventoryStockItemConfig,
  type InventoryStockTransactionConfig,
  type InventoryStockTransaction,
  type InventoryDerivedStockState
} from './scheduler/inventory.ts';

import {
  deriveMedicationStates,
  projectMedicationOccurrences,
  type MedicationScheduleConfig,
  type MedicationDerivedState
} from './scheduler/medication.ts';

export type ReminderDeliveryChannel = 'in_app' | 'browser' | 'web_push';
export type ReminderAttentionState =
  | 'pending'
  | 'delivered'
  | 'acknowledged'
  | 'snoozed'
  | 'dismissed'
  | 'completed'
  | 'canceled';
export type MaterializationPolicy =
  | 'project_only'
  | 'materialize_on_claim'
  | 'materialize_on_complete';

export interface ReminderRule {
  key: string;
  label: string;
  lead_minutes: number;
  channels: ReminderDeliveryChannel[];
}

export interface ReminderInstance {
  reminder_instance_id: string;
  occurrence_id: string;
  rule_key: string;
  channel: ReminderDeliveryChannel;
  display_title: string;
  source_kind: string;
  source_record_id: string;
  deliver_at: string;
  due_at: string;
  state: ReminderAttentionState;
  is_due: boolean;
  is_quiet_hours_delayed: boolean;
}

export interface PersistedReminderProjection {
  reminder_instance_id: string;
  occurrence_id: string;
  rule_key: string;
  channel: ReminderDeliveryChannel;
  display_title: string;
  source_kind: string;
  source_record_id: string;
  deliver_at: string;
  due_at: string;
  state: ReminderAttentionState;
  is_quiet_hours_delayed: boolean;
  occurrence_snapshot: OccurrenceSnapshot;
}

export interface StockSignal {
  stock_signal_id: string;
  stock_item_id: string;
  signal_kind: 'reorder' | 'depletion' | 'restock';
  current_quantity: number;
  reorder_point?: number | null;
  target_quantity?: number | null;
  projected_at: string;
  detail?: string;
}

export interface ProjectionWindow {
  start_at?: Date | string | null;
  end_at?: Date | string | null;
}

export interface ProjectionQuery {
  now?: Date;
  window?: ProjectionWindow;
  scope_ids?: string[] | null;
  include_source_kinds?: string[] | null;
  default_reminder_channels?: ReminderDeliveryChannel[] | null;
  quiet_hours?: SchedulerQuietHours | null;
}

export interface ScheduleSource {
  compiler_key: string;
  source_kind: string;
  source_record_id: string;
  source_template_id?: string | null;
  scope_ids?: string[] | null;
  occurrence_anchor: string;
  source_version_key: string;
  snapshot_hash: string;
  display_title: string;
  detail?: string;
}

export interface OccurrenceSnapshot {
  occurrence_id: string;
  snapshot_hash: string;
  source_version_key: string;
  source_kind: string;
  source_record_id: string;
  source_template_id?: string | null;
  start_at: string;
  end_at: string;
  date_scope_kind?: DateScopeKind;
  display_title: string;
  detail?: string;
  priority: number;
  surface_tags: string[];
  materialization_policy: MaterializationPolicy;
  stock_signal_id?: string | null;
}

export interface OccurrenceLedgerEntry {
  occurrence_id: string;
  snapshot_hash: string;
  source_version_key: string;
  frozen_start_at: string;
  frozen_end_at: string;
  reminder_state_by_rule: Record<string, ReminderAttentionState>;
  materialized_instance_id?: string | null;
  acknowledged_at?: string | null;
  snoozed_until?: string | null;
  completed_at?: string | null;
  canceled_at?: string | null;
  dismissed_at?: string | null;
  delivered_at?: string | null;
}

export interface SchedulerQuietHours {
  start: string | null;
  end: string | null;
}

export interface ProjectedOccurrence {
  occurrence_id: string;
  compiler_key: string;
  source_kind: string;
  source_record_id: string;
  source_template_id?: string | null;
  scope_ids?: string[] | null;
  start_at: string;
  end_at: string;
  date_scope_kind?: DateScopeKind;
  display_title: string;
  detail?: string;
  priority: number;
  surface_tags: string[];
  materialization_policy: MaterializationPolicy;
  stock_signal_id?: string | null;
  snapshot_hash: string;
  source_version_key: string;
  occurrence_anchor: string;
  reminder_rules: ReminderRule[];
}

export interface ScheduleCompilerContext {
  now: Date;
  query: ProjectionQuery;
  runtime?: AppRuntime | null;
}

export type ScheduleCompiler = (
  items: Item[],
  context: ScheduleCompilerContext
) => ProjectedOccurrence[];

export interface ProjectOccurrencesOptions {
  runtime?: AppRuntime | null;
  compilers?: ScheduleCompiler[];
  ledger?: Record<string, OccurrenceLedgerEntry>;
}

export const DEFAULT_SCHEDULER_REMINDER_CHANNELS: ReminderDeliveryChannel[] = ['in_app'];

const OCCURRENCE_LEDGER_STORAGE_PREFIX = 'scheduler:ledger:';

export function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return Math.abs(hash >>> 0).toString(36);
}

export function normalizeRecordId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return trimmed.includes(':') ? trimmed : `records:${trimmed}`;
}

/**
 * Normalize a currency code to an uppercase ISO-4217-shaped 3-letter string.
 * Returns `fallback` (default `null`) when the value is missing or malformed.
 * Modules that require a concrete currency pass a string fallback (e.g.
 * `'USD'`) and get a `string` back.
 */
export function normalizeCurrency(value: unknown): string | null;
export function normalizeCurrency(value: unknown, fallback: string): string;
export function normalizeCurrency(value: unknown, fallback: string | null = null): string | null {
  const trimmed = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : fallback;
}

export function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

const stableStringifyCollator = new Intl.Collator();

export function stringifyStable(value: unknown): string {
  return JSON.stringify(value, (_key, source) => {
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      return Object.fromEntries(
        Object.entries(source as Record<string, unknown>).sort(([left], [right]) =>
          stableStringifyCollator.compare(left, right)
        )
      );
    }
    return source;
  });
}

export function itemScopeIds(item: Item): string[] {
  const out = new Set<string>();
  const parentId = normalizeRecordId(item.parent);
  if (parentId) out.add(parentId);
  for (const group of (item as Item & { grouping?: Array<{ id?: string | null }> }).grouping ?? []) {
    const id = normalizeRecordId(group?.id ?? null);
    if (id) out.add(id);
  }
  return [...out];
}

export function inventoryModuleSettings(item: Item): Record<string, unknown> {
  return (item.module_settings?.inventory_module ?? {}) as Record<string, unknown>;
}

export function medicationModuleSettings(item: Item): Record<string, unknown> {
  return (item.module_settings?.medication_module ?? {}) as Record<string, unknown>;
}

export function asFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}


export function matchesScope(item: Item, scopeIds: string[] | null | undefined): boolean {
  if (!scopeIds?.length) return true;
  const wanted = new Set(scopeIds.map((id) => normalizeRecordId(id) ?? id));
  return itemScopeIds(item).some((id) => wanted.has(id));
}

export function matchesWindow(
  startAt: Date,
  endAt: Date,
  window: ProjectionWindow | null | undefined
): boolean {
  const start = asDate(window?.start_at);
  const end = asDate(window?.end_at);
  if (start && endAt.getTime() < start.getTime()) return false;
  if (end && startAt.getTime() > end.getTime()) return false;
  return true;
}

function baseReminderChannels(query: ProjectionQuery): ReminderDeliveryChannel[] {
  return query.default_reminder_channels?.length
    ? [...query.default_reminder_channels]
    : [...DEFAULT_SCHEDULER_REMINDER_CHANNELS];
}

export function reminderRulesForItem(
  item: Item,
  query: ProjectionQuery,
  extraLeadDays?: number[] | null
): ReminderRule[] {
  const moduleSettings = (item.module_settings ?? {}) as Record<string, unknown>;
  const schedulerSettings = (moduleSettings.scheduler_module ?? {}) as Record<string, unknown>;
  const configuredChannels = Array.isArray(schedulerSettings.default_reminder_channels)
    ? (schedulerSettings.default_reminder_channels.filter(
        (value): value is ReminderDeliveryChannel =>
          value === 'in_app' || value === 'browser' || value === 'web_push'
      ) as ReminderDeliveryChannel[])
    : baseReminderChannels(query);

  const leadMinutes = new Set<number>([0]);
  const configuredLeadMinutes = Array.isArray(schedulerSettings.reminder_lead_minutes)
    ? schedulerSettings.reminder_lead_minutes
    : [];
  for (const entry of configuredLeadMinutes) {
    const minutes = Number(entry);
    if (Number.isFinite(minutes) && minutes >= 0) {
      leadMinutes.add(Math.floor(minutes));
    }
  }
  for (const entry of extraLeadDays ?? []) {
    const days = Number(entry);
    if (Number.isFinite(days) && days >= 0) {
      leadMinutes.add(Math.floor(days * 24 * 60));
    }
  }

  return [...leadMinutes]
    .sort((left, right) => right - left)
    .map((minutes) => ({
      key: minutes === 0 ? 'due' : `lead-${minutes}`,
      label: minutes === 0 ? 'Due now' : `${minutes} minutes before`,
      lead_minutes: minutes,
      channels: minutes === 0 ? configuredChannels : ['in_app', ...configuredChannels.filter((channel) => channel !== 'in_app')]
    }));
}

export function computePriority(startAt: Date, now: Date): number {
  const delta = startAt.getTime() - now.getTime();
  if (delta <= 0) return 100;
  if (delta <= 2 * HOUR_MS) return 90;
  if (delta <= DAY_MS) return 70;
  if (delta <= 7 * DAY_MS) return 50;
  return 20;
}

export function computeOccurrenceId(parts: {
  sourceIdentity: string;
  occurrenceAnchor: string;
  compilerKey: string;
  versionBoundary: string;
}): string {
  return `occ:${stableHash(
    `${parts.compilerKey}|${parts.sourceIdentity}|${parts.occurrenceAnchor}|${parts.versionBoundary}`
  )}`;
}

function freezeOccurrenceWithLedger(
  occurrence: ProjectedOccurrence,
  ledgerEntry: OccurrenceLedgerEntry | undefined
): ProjectedOccurrence {
  if (!ledgerEntry) return occurrence;
  return {
    ...occurrence,
    start_at: ledgerEntry.frozen_start_at,
    end_at: ledgerEntry.frozen_end_at,
    snapshot_hash: ledgerEntry.snapshot_hash,
    source_version_key: ledgerEntry.source_version_key
  };
}

function occurrenceSnapshotHash(
  item: Item,
  additionalId: string,
  startAt: Date,
  endAt: Date,
  dateScopeKind?: DateScopeKind
): string {
  return stableHash(
    stringifyStable({
      item_id: item.id,
      text: item.text,
      module_settings: item.module_settings ?? null,
      additionals: item.additionals ?? [],
      additional_id: additionalId,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      date_scope_kind: dateScopeKind ?? null
    })
  );
}

function occurrenceVersionKey(item: Item, additionalId: string): string {
  return stableHash(
    stringifyStable({
      item_id: item.id,
      text: item.text,
      additional_id: additionalId,
      additionals: item.additionals ?? [],
      module_settings: item.module_settings ?? null
    })
  );
}

export function createOccurrenceSnapshot(
  occurrence: ProjectedOccurrence
): OccurrenceSnapshot {
  return {
    occurrence_id: occurrence.occurrence_id,
    snapshot_hash: occurrence.snapshot_hash,
    source_version_key: occurrence.source_version_key,
    source_kind: occurrence.source_kind,
    source_record_id: occurrence.source_record_id,
    source_template_id: occurrence.source_template_id ?? null,
    start_at: occurrence.start_at,
    end_at: occurrence.end_at,
    date_scope_kind: occurrence.date_scope_kind,
    display_title: occurrence.display_title,
    detail: occurrence.detail,
    priority: occurrence.priority,
    surface_tags: [...occurrence.surface_tags],
    materialization_policy: occurrence.materialization_policy,
    stock_signal_id: occurrence.stock_signal_id ?? null
  };
}

export function upsertOccurrenceLedgerEntry(
  existing: OccurrenceLedgerEntry | undefined,
  occurrence: ProjectedOccurrence,
  patch?: Partial<OccurrenceLedgerEntry>
): OccurrenceLedgerEntry {
  const base: OccurrenceLedgerEntry =
    existing ??
    {
      occurrence_id: occurrence.occurrence_id,
      snapshot_hash: occurrence.snapshot_hash,
      source_version_key: occurrence.source_version_key,
      frozen_start_at: occurrence.start_at,
      frozen_end_at: occurrence.end_at,
      reminder_state_by_rule: {}
    };

  return {
    ...base,
    ...patch,
    occurrence_id: base.occurrence_id,
    snapshot_hash: base.snapshot_hash,
    source_version_key: base.source_version_key,
    frozen_start_at: base.frozen_start_at,
    frozen_end_at: base.frozen_end_at,
    reminder_state_by_rule: {
      ...base.reminder_state_by_rule,
      ...(patch?.reminder_state_by_rule ?? {})
    }
  };
}

export function applyOccurrenceLedger(
  occurrences: ProjectedOccurrence[],
  ledger: Record<string, OccurrenceLedgerEntry> | null | undefined
): ProjectedOccurrence[] {
  if (!ledger) return occurrences;
  return occurrences.map((occurrence) =>
    freezeOccurrenceWithLedger(occurrence, ledger[occurrence.occurrence_id])
  );
}

export function loadOccurrenceLedger(storageNamespace: string): Record<string, OccurrenceLedgerEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(`${OCCURRENCE_LEDGER_STORAGE_PREFIX}${storageNamespace}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, OccurrenceLedgerEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveOccurrenceLedger(
  storageNamespace: string,
  ledger: Record<string, OccurrenceLedgerEntry>
): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    `${OCCURRENCE_LEDGER_STORAGE_PREFIX}${storageNamespace}`,
    JSON.stringify(ledger)
  );
}

type SchedulerLedgerModuleData = {
  kind?: string;
  occurrence_id?: string;
  source_kind?: string;
  source_record_id?: string;
  occurrence_ledger?: OccurrenceLedgerEntry;
};

type SchedulerProjectedReminderModuleData = {
  kind?: string;
  reminder_instance_id?: string;
  projected_reminder?: PersistedReminderProjection;
};

function schedulerLedgerModuleSettings(
  occurrence: ProjectedOccurrence,
  entry: OccurrenceLedgerEntry
): Record<string, unknown> {
  return {
    scheduler_module: {
      kind: 'occurrence_ledger',
      occurrence_id: occurrence.occurrence_id,
      source_kind: occurrence.source_kind,
      source_record_id: occurrence.source_record_id,
      occurrence_ledger: entry
    } satisfies SchedulerLedgerModuleData
  };
}

function schedulerLedgerFromItem(item: Item): {
  recordId: string;
  occurrenceId: string;
  entry: OccurrenceLedgerEntry;
} | null {
  const schedulerModule = (item.module_settings?.scheduler_module ?? null) as SchedulerLedgerModuleData | null;
  if (!schedulerModule || schedulerModule.kind !== 'occurrence_ledger') return null;
  if (typeof schedulerModule.occurrence_id !== 'string') return null;
  if (!schedulerModule.occurrence_ledger || typeof schedulerModule.occurrence_ledger !== 'object') return null;
  return {
    recordId: String(item.id),
    occurrenceId: schedulerModule.occurrence_id,
    entry: schedulerModule.occurrence_ledger
  };
}

function schedulerProjectedReminderFromItem(item: Item): {
  recordId: string;
  reminderInstanceId: string;
  projection: PersistedReminderProjection;
} | null {
  const schedulerModule = (item.module_settings?.scheduler_module ?? null) as SchedulerProjectedReminderModuleData | null;
  if (!schedulerModule || schedulerModule.kind !== 'projected_reminder') return null;
  if (typeof schedulerModule.reminder_instance_id !== 'string') return null;
  if (!schedulerModule.projected_reminder || typeof schedulerModule.projected_reminder !== 'object') return null;
  return {
    recordId: String(item.id),
    reminderInstanceId: schedulerModule.reminder_instance_id,
    projection: schedulerModule.projected_reminder
  };
}

function schedulerProjectedReminderModuleSettings(
  reminder: ReminderInstance,
  occurrence: ProjectedOccurrence
): Record<string, unknown> {
  const projection: PersistedReminderProjection = {
    reminder_instance_id: reminder.reminder_instance_id,
    occurrence_id: reminder.occurrence_id,
    rule_key: reminder.rule_key,
    channel: reminder.channel,
    display_title: reminder.display_title,
    source_kind: reminder.source_kind,
    source_record_id: reminder.source_record_id,
    deliver_at: reminder.deliver_at,
    due_at: reminder.due_at,
    state: reminder.state,
    is_quiet_hours_delayed: reminder.is_quiet_hours_delayed,
    occurrence_snapshot: createOccurrenceSnapshot(occurrence)
  };

  return {
    scheduler_module: {
      kind: 'projected_reminder',
      reminder_instance_id: reminder.reminder_instance_id,
      projected_reminder: projection
    } satisfies SchedulerProjectedReminderModuleData
  };
}

export function readRuntimeOccurrenceLedger(
  runtime: AppRuntime | null | undefined,
  stateRootId: string | null | undefined
): Record<string, OccurrenceLedgerEntry> {
  if (!runtime || !stateRootId) return {};
  const out: Record<string, OccurrenceLedgerEntry> = {};
  const rootId = normalizeRecordId(stateRootId) ?? stateRootId;
  for (const edge of runtime.cache.get_children_for_parent(rootId)) {
    const item = runtime.cache.getItem(edge.child_id) as Item | undefined;
    if (!item) continue;
    const ledger = schedulerLedgerFromItem(item);
    if (!ledger) continue;
    out[ledger.occurrenceId] = ledger.entry;
  }
  return out;
}

export function resolveOccurrenceLedger(args: {
  storageNamespace: string;
  runtime?: AppRuntime | null;
  stateRootId?: string | null;
}): Record<string, OccurrenceLedgerEntry> {
  return {
    ...loadOccurrenceLedger(args.storageNamespace),
    ...readRuntimeOccurrenceLedger(args.runtime, args.stateRootId)
  };
}

function runtimeLedgerRecordIdForOccurrence(
  runtime: AppRuntime,
  stateRootId: string,
  occurrenceId: string
): string | null {
  const rootId = normalizeRecordId(stateRootId) ?? stateRootId;
  for (const edge of runtime.cache.get_children_for_parent(rootId)) {
    const item = runtime.cache.getItem(edge.child_id) as Item | undefined;
    if (!item) continue;
    const ledger = schedulerLedgerFromItem(item);
    if (ledger?.occurrenceId === occurrenceId) {
      return ledger.recordId;
    }
  }

  for (const item of runtime.cache.getAllItems() as Item[]) {
    const ledger = schedulerLedgerFromItem(item);
    if (ledger?.occurrenceId === occurrenceId) {
      return ledger.recordId;
    }
  }

  return null;
}

export function persistOccurrenceLedgerEntryToRuntime(args: {
  runtime: AppRuntime | null | undefined;
  stateRootId: string | null | undefined;
  occurrence: ProjectedOccurrence;
  entry: OccurrenceLedgerEntry;
}): string | null {
  const { runtime, stateRootId, occurrence, entry } = args;
  if (!runtime || !stateRootId) return null;

  const rootId = normalizeRecordId(stateRootId) ?? stateRootId;
  const existingId = runtimeLedgerRecordIdForOccurrence(runtime, rootId, occurrence.occurrence_id);
  const moduleSettings = schedulerLedgerModuleSettings(occurrence, entry);

  if (existingId) {
    runtime.cache.patch_item_module_settings(existingId, moduleSettings);
    runtime.queueAndWake('UpdateRecord', {
      id: existingId,
      module_settings: moduleSettings
    });
    return existingId;
  }

  const recordId = `temp:${crypto.randomUUID()}`;
  runtime.cache.normalizeItem({
    id: recordId,
    text: `Scheduler ledger · ${occurrence.display_title}`,
    module_settings: moduleSettings,
    is_temp: true,
    dirty: true,
    sync_status: 'pending'
  });
  runtime.queueAndWake('CreateRecord', {
    id: recordId,
    text: `Scheduler ledger · ${occurrence.display_title}`,
    module_settings: moduleSettings,
    is_temp: true,
    sync_status: 'pending'
  });

  const edgeId = `temp-edge:${crypto.randomUUID()}`;
  runtime.cache.upsert_graph_child_of_edge(edgeId, recordId, rootId, 0, true);
  runtime.queueAndWake('AddChild', {
    parent: rootId,
    child: recordId,
    order: 0,
    key_parent: true
  });
  return recordId;
}

export function mutateOccurrenceLedger(
  storageNamespace: string,
  occurrence: ProjectedOccurrence,
  updater: (entry: OccurrenceLedgerEntry | undefined) => OccurrenceLedgerEntry,
  options?: {
    runtime?: AppRuntime | null;
    stateRootId?: string | null;
  }
): Record<string, OccurrenceLedgerEntry> {
  const ledger = loadOccurrenceLedger(storageNamespace);
  ledger[occurrence.occurrence_id] = updater(ledger[occurrence.occurrence_id]);
  saveOccurrenceLedger(storageNamespace, ledger);
  persistOccurrenceLedgerEntryToRuntime({
    runtime: options?.runtime,
    stateRootId: options?.stateRootId,
    occurrence,
    entry: ledger[occurrence.occurrence_id]
  });
  return ledger;
}

export function isReminderPendingDelivery(reminder: ReminderInstance): boolean {
  return (
    reminder.is_due &&
    (reminder.state === 'pending' || reminder.state === 'snoozed')
  );
}

export function syncProjectedReminderInstancesToRuntime(args: {
  runtime: AppRuntime | null | undefined;
  stateRootId: string | null | undefined;
  occurrences: ProjectedOccurrence[];
  reminders: ReminderInstance[];
}): void {
  const { runtime, stateRootId, occurrences, reminders } = args;
  if (!runtime || !stateRootId) return;

  const rootId = normalizeRecordId(stateRootId) ?? stateRootId;
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence]));
  const desiredReminders = reminders.filter(
    (reminder) =>
      reminder.channel === 'web_push' &&
      (reminder.state === 'pending' || reminder.state === 'snoozed')
  );
  const desiredIds = new Set(desiredReminders.map((reminder) => reminder.reminder_instance_id));
  const existingByReminderId = new Map<
    string,
    { recordId: string; projection: PersistedReminderProjection }
  >();

  for (const edge of runtime.cache.get_children_for_parent(rootId)) {
    const item = runtime.cache.getItem(edge.child_id) as Item | undefined;
    if (!item) continue;
    const projection = schedulerProjectedReminderFromItem(item);
    if (!projection) continue;
    existingByReminderId.set(projection.reminderInstanceId, {
      recordId: projection.recordId,
      projection: projection.projection
    });
  }

  for (const reminder of desiredReminders) {
    const occurrence = occurrenceById.get(reminder.occurrence_id);
    if (!occurrence) continue;

    const moduleSettings = schedulerProjectedReminderModuleSettings(reminder, occurrence);
    const desiredProjection =
      ((moduleSettings.scheduler_module as SchedulerProjectedReminderModuleData).projected_reminder ??
        null) as PersistedReminderProjection | null;
    if (!desiredProjection) continue;

    const existing = existingByReminderId.get(reminder.reminder_instance_id);
    if (existing) {
      if (stringifyStable(existing.projection) === stringifyStable(desiredProjection)) {
        continue;
      }
      runtime.cache.patch_item_module_settings(existing.recordId, moduleSettings);
      runtime.queueAndWake('UpdateRecord', {
        id: existing.recordId,
        module_settings: moduleSettings
      });
      continue;
    }

    const recordId = `temp:${crypto.randomUUID()}`;
    runtime.cache.normalizeItem({
      id: recordId,
      text: `Scheduler reminder · ${reminder.display_title}`,
      module_settings: moduleSettings,
      is_temp: true,
      dirty: true,
      sync_status: 'pending'
    });
    runtime.queueAndWake('CreateRecord', {
      id: recordId,
      text: `Scheduler reminder · ${reminder.display_title}`,
      module_settings: moduleSettings,
      is_temp: true,
      sync_status: 'pending'
    });

    const edgeId = `temp-edge:${crypto.randomUUID()}`;
    runtime.cache.upsert_graph_child_of_edge(edgeId, recordId, rootId, 0, true);
    runtime.queueAndWake('AddChild', {
      parent: rootId,
      child: recordId,
      order: 0,
      key_parent: true
    });
  }

  for (const [reminderInstanceId, existing] of existingByReminderId) {
    if (desiredIds.has(reminderInstanceId)) continue;
    runtime.queueAndWake('DeleteTree', { id: existing.recordId });
  }
}






export function projectDateOccurrences(
  items: Item[],
  context: ScheduleCompilerContext
): ProjectedOccurrence[] {
  const out: ProjectedOccurrence[] = [];

  for (const item of items) {
    if (!matchesScope(item, context.query.scope_ids)) continue;

    for (const additional of item.additionals ?? []) {
      if (!isDateAdditional(additional)) continue;
      const dateInfo = getDateAdditionalData(additional)?.date_info;
      if (!dateInfo?.value) continue;

      let startAt: Date;
      let endAt: Date;
      let dateScopeKind: DateScopeKind;
      try {
        const window = resolveTimeWindow(dateInfo.value, context.now, { userProvided: context.now });
        startAt = window.start;
        endAt = window.end;
        dateScopeKind = window.kind;
      } catch {
        continue;
      }

      if (!matchesWindow(startAt, endAt, context.query.window)) continue;

      const versionKey = occurrenceVersionKey(item, additional.id);
      const snapshotHash = occurrenceSnapshotHash(item, additional.id, startAt, endAt, dateScopeKind);
      const occurrenceAnchor = startAt.toISOString();
      const occurrenceId = computeOccurrenceId({
        sourceIdentity: String(item.id),
        occurrenceAnchor,
        compilerKey: 'generic-date',
        versionBoundary: versionKey
      });

      out.push({
        occurrence_id: occurrenceId,
        compiler_key: 'generic-date',
        source_kind: item.original_template_id ? 'planner-instance' : 'record-date',
        source_record_id: String(item.id),
        source_template_id: item.original_template_id
          ? normalizeRecordId(String(item.original_template_id))
          : null,
        scope_ids: itemScopeIds(item),
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        date_scope_kind: dateScopeKind,
        display_title: item.text?.trim() || String(item.id),
        detail: undefined,
        priority: computePriority(startAt, context.now),
        surface_tags: ['exec', 'planner', 'reminders'],
        materialization_policy: 'project_only',
        stock_signal_id: null,
        snapshot_hash: snapshotHash,
        source_version_key: versionKey,
        occurrence_anchor: occurrenceAnchor,
        reminder_rules: reminderRulesForItem(item, context.query)
      });
    }
  }

  return out;
}



export function projectOccurrences(
  items: Item[],
  query: ProjectionQuery = {},
  options: ProjectOccurrencesOptions = {}
): ProjectedOccurrence[] {
  const now = query.now ?? new Date();
  const context: ScheduleCompilerContext = {
    now,
    query,
    runtime: options.runtime ?? null
  };

  const compilers = options.compilers?.length
    ? options.compilers
    : [projectDateOccurrences, projectInventoryOccurrences, projectMedicationOccurrences];

  let occurrences = compilers.flatMap((compiler) => compiler(items, context));

  if (query.include_source_kinds?.length) {
    const allowed = new Set(query.include_source_kinds);
    occurrences = occurrences.filter((occurrence) => allowed.has(occurrence.source_kind));
  }

  return applyOccurrenceLedger(occurrences, options.ledger).sort((left, right) => {
    const startDiff = left.start_at < right.start_at ? -1 : left.start_at > right.start_at ? 1 : 0;
    if (startDiff !== 0) return startDiff;
    return right.priority - left.priority;
  });
}

export function projectRuntimeOccurrences(
  runtime: AppRuntime | null | undefined,
  query: ProjectionQuery = {},
  options: Omit<ProjectOccurrencesOptions, 'runtime'> = {}
): ProjectedOccurrence[] {
  if (!runtime) return [];
  const items = runtime.cache.getAllItems() as Item[];
  return projectOccurrences(items, query, {
    ...options,
    runtime
  });
}

function parseTimeOfDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

export function isWithinQuietHours(
  at: Date,
  quietHours: SchedulerQuietHours | null | undefined
): boolean {
  const start = parseTimeOfDay(quietHours?.start ?? null);
  const end = parseTimeOfDay(quietHours?.end ?? null);
  if (start == null || end == null || start === end) return false;
  const minute = at.getHours() * 60 + at.getMinutes();
  if (start < end) {
    return minute >= start && minute < end;
  }
  return minute >= start || minute < end;
}

export function adjustForQuietHours(
  at: Date,
  quietHours: SchedulerQuietHours | null | undefined
): { deliverAt: Date; delayed: boolean } {
  if (!isWithinQuietHours(at, quietHours)) {
    return { deliverAt: at, delayed: false };
  }

  const end = parseTimeOfDay(quietHours?.end ?? null);
  if (end == null) return { deliverAt: at, delayed: false };

  const deliverAt = new Date(at);
  const minute = at.getHours() * 60 + at.getMinutes();
  if (parseTimeOfDay(quietHours?.start ?? null)! > end && minute >= parseTimeOfDay(quietHours?.start ?? null)!) {
    deliverAt.setDate(deliverAt.getDate() + 1);
  }
  deliverAt.setHours(Math.floor(end / 60), end % 60, 0, 0);
  return { deliverAt, delayed: true };
}

function reminderStateFor(
  ledgerEntry: OccurrenceLedgerEntry | undefined,
  ruleKey: string,
  channel: ReminderDeliveryChannel
): ReminderAttentionState {
  return ledgerEntry?.reminder_state_by_rule?.[`${ruleKey}:${channel}`] ?? 'pending';
}

export function buildReminderInstances(
  occurrences: ProjectedOccurrence[],
  query: ProjectionQuery = {},
  ledger: Record<string, OccurrenceLedgerEntry> | null | undefined = {}
): ReminderInstance[] {
  const now = query.now ?? new Date();
  const out: ReminderInstance[] = [];

  for (const occurrence of occurrences) {
    const ledgerEntry = ledger?.[occurrence.occurrence_id];
    const occurrenceStart = asDate(occurrence.start_at);
    if (!occurrenceStart) continue;

    for (const rule of occurrence.reminder_rules) {
      for (const channel of rule.channels) {
        const rawDeliverAt = new Date(occurrenceStart.getTime() - rule.lead_minutes * MINUTE_MS);
        const adjusted = channel === 'in_app'
          ? { deliverAt: rawDeliverAt, delayed: false }
          : adjustForQuietHours(rawDeliverAt, query.quiet_hours);
        const state = reminderStateFor(ledgerEntry, rule.key, channel);
        const dueAt = ledgerEntry?.snoozed_until
          ? new Date(ledgerEntry.snoozed_until)
          : adjusted.deliverAt;

        out.push({
          reminder_instance_id: `rem:${stableHash(`${occurrence.occurrence_id}|${rule.key}|${channel}`)}`,
          occurrence_id: occurrence.occurrence_id,
          rule_key: rule.key,
          channel,
          display_title: occurrence.display_title,
          source_kind: occurrence.source_kind,
          source_record_id: occurrence.source_record_id,
          deliver_at: adjusted.deliverAt.toISOString(),
          due_at: dueAt.toISOString(),
          state,
          is_due:
            dueAt.getTime() <= now.getTime() &&
            state !== 'acknowledged' &&
            state !== 'completed' &&
            state !== 'dismissed' &&
            state !== 'canceled',
          is_quiet_hours_delayed: adjusted.delayed
        });
      }
    }
  }

  return out.sort((left, right) =>
    left.due_at < right.due_at ? -1 : left.due_at > right.due_at ? 1 : 0
  );
}
