import type {
  TimeReference,
  BaseOrVagueReference,
  StartOrEnd,
  DateInformation,
  RelevanceWindow
} from './types.ts';
import {
  VAGUE_MINUTES,
  VAGUE_DAYS,
  VAGUE_MONTHS,
  type VagueMinuteCode,
  type VagueDayCode,
  type VagueMonthCode
} from './vague-time.ts';
import {
  extractDateWindow,
  weekModeFor
} from './time-week.ts';
import {
  explicitTimeReference,
  relativeTimeReference,
  resolveEnd,
  resolveStart,
  type ResolveContext
} from './time-reference.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimeReferenceField = 'y' | 'm' | 'w' | 'd' | 'i';
export type TimeReferenceSide = 's' | 'e';

export interface TimeReferenceValidationIssue {
  code:
    | 'vague_month_has_day'
    | 'vague_month_has_week'
    | 'vague_month_has_time'
    | 'vague_day_has_time'
    | 'end_before_start'
    | 'missing_start_date'
    | 'unsupported_reference';
  side?: TimeReferenceSide;
  field?: TimeReferenceField;
  message: string;
}

export interface TimeReferenceValidationResult {
  valid: boolean;
  issues: TimeReferenceValidationIssue[];
}

export interface NormalizeTimeReferenceOptions {
  pruneInvalidEnd?: boolean;
  trimImplicitEnds?: boolean;
  sanitizeVague?: boolean;
}

export interface NormalizeDateInformationForPersistenceOptions {
  /**
   * `preserve` keeps the edited TimeReference shape and only normalizes it.
   * `absolute` resolves and stores base date/time refs.
   * `relative` resolves and stores offsets from `relativeAnchor`.
   */
  output?: 'preserve' | 'absolute' | 'relative';
  resolveNow?: Date;
  resolveContext?: ResolveContext;
  relativeAnchor?: Date;
  relativeAnchorType?: 'up' | 'pr';
  dateOnly?: boolean;
  timeReference?: NormalizeTimeReferenceOptions;
}

export interface FormatTimeReferenceOptions {
  includeDate?: boolean;
  includeTime?: boolean;
  side?: 'start' | 'end' | 'range';
  fallback?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function cloneRef<VRT extends string, T>(
  value: BaseOrVagueReference<VRT, T> | undefined
): BaseOrVagueReference<VRT, T> | undefined {
  return value ? { ...value } : undefined;
}

function cloneStartOrEnd<VRT extends string, T>(
  value: StartOrEnd<VRT, T> | undefined
): StartOrEnd<VRT, T> | undefined {
  if (!value) return undefined;
  return {
    ...(value.s ? { s: cloneRef(value.s) } : {}),
    ...(value.e ? { e: cloneRef(value.e) } : {})
  };
}

export function cloneTimeReference(value: TimeReference | undefined): TimeReference {
  if (!value) return {};
  return {
    ...(value.y ? { y: cloneStartOrEnd(value.y) } : {}),
    ...(value.m ? { m: cloneStartOrEnd(value.m) } : {}),
    ...(value.w ? { w: cloneStartOrEnd(value.w) } : {}),
    ...(value.d ? { d: cloneStartOrEnd(value.d) } : {}),
    ...(value.i ? { i: cloneStartOrEnd(value.i) } : {}),
    ...(value.wm ? { wm: value.wm } : {}),
    ...(typeof value.ws === 'number' ? { ws: value.ws } : {})
  };
}

export function getSideRef<VRT extends string>(
  value: TimeReference | undefined,
  field: TimeReferenceField,
  side: TimeReferenceSide
): BaseOrVagueReference<VRT, number> | undefined {
  if (!value) return undefined;
  const f = value[field];
  if (!f) return undefined;
  return f[side] as BaseOrVagueReference<VRT, number> | undefined;
}

export function setSideRef<VRT extends string>(
  value: TimeReference,
  field: TimeReferenceField,
  side: TimeReferenceSide,
  ref: BaseOrVagueReference<VRT, number> | undefined
): void {
  const existing = value[field];
  if (ref) {
    value[field] = {
      ...(existing || {}),
      [side]: ref
    } as StartOrEnd<VRT, number>;
  } else if (existing) {
    const { [side]: _, ...rest } = existing;
    if (Object.keys(rest).length > 0) {
      value[field] = rest as StartOrEnd<VRT, number>;
    } else {
      delete (value as any)[field];
    }
  }
}

export function isVague(ref: BaseOrVagueReference<string, number> | undefined): boolean {
  return ref?.type === 'vg';
}

export function isBase(ref: BaseOrVagueReference<string, number> | undefined): boolean {
  return ref?.type === 'ba';
}

export function isOffset(ref: BaseOrVagueReference<string, number> | undefined): boolean {
  return ref?.type === 'of';
}

export function refsEqual(
  a: BaseOrVagueReference<string, number> | undefined,
  b: BaseOrVagueReference<string, number> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'ba') return a.v === (b as typeof a).v;
  if (a.type === 'vg') return a.t === (b as typeof a).t;
  if (a.type === 'of') return a.v === (b as typeof a).v && a.a === (b as typeof a).a;
  return false;
}

export function cleanupEmptyFields(value: TimeReference): TimeReference {
  for (const field of ['y', 'm', 'w', 'd', 'i'] as TimeReferenceField[]) {
    const f = value[field];
    if (f && !f.s && !f.e) {
      delete (value as any)[field];
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Resolve a start/end minute-of-day pair to comparable values for ordering
 * checks. Concrete refs compare by value. Two vague refs compare by their
 * bucket midpoints (`VAGUE_MINUTES[code].base`), so Night → Evening counts as
 * reversed even though the raw ranges overlap. A vague ref paired with a
 * concrete one uses its most permissive range bound, so a pair is only flagged
 * when no valid interpretation exists (e.g. 4:40 PM → "Afternoon" is fine
 * because Afternoon runs until 6 PM). Offset refs are anchored at resolve time
 * and cannot be ordered statically, so they yield null, as does any missing
 * ref.
 */
export function comparableMinuteBounds(
  start: BaseOrVagueReference<string, number> | undefined,
  end: BaseOrVagueReference<string, number> | undefined
): { start: number; end: number } | null {
  if (!start || !end) return null;
  if (start.type === 'ba' && end.type === 'ba') {
    return { start: start.v, end: end.v };
  }
  if (start.type === 'vg' && end.type === 'vg') {
    const s = VAGUE_MINUTES[start.t as VagueMinuteCode];
    const e = VAGUE_MINUTES[end.t as VagueMinuteCode];
    if (!s || !e) return null;
    return { start: s.base, end: e.base };
  }
  if (start.type === 'vg' && end.type === 'ba') {
    const s = VAGUE_MINUTES[start.t as VagueMinuteCode];
    return s ? { start: s.range[0], end: end.v } : null;
  }
  if (start.type === 'ba' && end.type === 'vg') {
    const e = VAGUE_MINUTES[end.t as VagueMinuteCode];
    return e ? { start: start.v, end: e.range[1] } : null;
  }
  return null;
}

/** True when both minute refs are present, orderable, and reversed. */
export function isMinutePairReversed(
  start: BaseOrVagueReference<string, number> | null | undefined,
  end: BaseOrVagueReference<string, number> | null | undefined
): boolean {
  const bounds = comparableMinuteBounds(start ?? undefined, end ?? undefined);
  return bounds !== null && bounds.end < bounds.start;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateTimeReferenceStructure(
  value: TimeReference | undefined,
  options: { allowOffsets?: boolean; requireStartDate?: boolean } = {}
): TimeReferenceValidationResult {
  const issues: TimeReferenceValidationIssue[] = [];
  const { allowOffsets = false, requireStartDate = true } = options;

  if (!value) {
    if (requireStartDate) {
      issues.push({ code: 'missing_start_date', message: 'A start date is required.' });
    }
    return { valid: issues.length === 0, issues };
  }

  // Missing start date check
  if (requireStartDate) {
    const hasStartDate = Boolean(value.y?.s || value.m?.s || value.w?.s || value.d?.s);
    if (!hasStartDate) {
      issues.push({ code: 'missing_start_date', message: 'A start date is required.' });
    }
  }

  // Unsupported offset references
  if (!allowOffsets) {
    for (const field of ['y', 'm', 'w', 'd', 'i'] as TimeReferenceField[]) {
      for (const side of ['s', 'e'] as TimeReferenceSide[]) {
        const ref = getSideRef(value, field, side);
        if (ref?.type === 'of') {
          issues.push({
            code: 'unsupported_reference',
            field,
            side,
            message: `Offset references are not supported in this editor.`
          });
        }
      }
    }
  }

  // Vague hierarchy rules per side
  for (const side of ['s', 'e'] as TimeReferenceSide[]) {
    const monthRef = getSideRef(value, 'm', side);
    const weekRef = getSideRef(value, 'w', side);
    const dayRef = getSideRef(value, 'd', side);
    const minuteRef = getSideRef(value, 'i', side);

    if (isVague(weekRef)) {
      issues.push({
        code: 'unsupported_reference',
        field: 'w',
        side,
        message: side === 's'
          ? 'Vague start week is no longer supported. Please clear or choose an exact week.'
          : 'Vague end week is no longer supported. Please clear or choose an exact week.'
      });
    }

    if (isVague(monthRef)) {
      if (isBase(weekRef) || isVague(weekRef)) {
        issues.push({
          code: 'vague_month_has_week',
          side,
          message: side === 's'
            ? 'Vague start month cannot have a week. Please clear the week first.'
            : 'Vague end month cannot have a week. Please clear the week first.'
        });
      }
      if (isBase(dayRef) || isVague(dayRef)) {
        issues.push({
          code: 'vague_month_has_day',
          side,
          message: side === 's'
            ? 'Vague start month cannot have a day. Please clear the day first.'
            : 'Vague end month cannot have a day. Please clear the day first.'
        });
      }
      if (isBase(minuteRef) || isVague(minuteRef)) {
        issues.push({
          code: 'vague_month_has_time',
          side,
          message: side === 's'
            ? 'Vague start month cannot have a time. Please clear the time first.'
            : 'Vague end month cannot have a time. Please clear the time first.'
        });
      }
    }

    if (isVague(dayRef) && (isBase(minuteRef) || isVague(minuteRef))) {
      issues.push({
        code: 'vague_day_has_time',
        side,
        message: side === 's'
          ? 'Vague start day cannot have a time. Please clear the time first.'
          : 'Vague end day cannot have a time. Please clear the time first.'
      });
    }
  }

  // End-before-start check: only when an explicit end is authored and the
  // date window is deterministically comparable. extractDateWindow inherits
  // missing end date refs from the start side (matching how persistence trims
  // redundant end year/month), so trimmed multi-day refs resolve correctly.
  const window = extractDateWindow(value);
  if (window && hasExplicitEnd(value)) {
    const startMinuteRef = getSideRef(value, 'i', 's');
    const endMinuteRef = getSideRef(value, 'i', 'e');
    // When no explicit end minute is authored, the end instant inherits the
    // start minute (a point-in-time event). Without this, a single-day event
    // with only a start time compared its start time against an implicit end
    // of 00:00 on the same day and falsely tripped end_before_start — which
    // disabled the calendar create button the moment a time was added.
    const bounds = comparableMinuteBounds(startMinuteRef, endMinuteRef ?? startMinuteRef);
    const startTs = new Date(window.start).setHours(0, bounds?.start ?? 0, 0, 0);
    const endTs = new Date(window.end).setHours(0, bounds?.end ?? 0, 0, 0);
    if (endTs < startTs) {
      issues.push({
        code: 'end_before_start',
        message: 'End date/time cannot be before start date/time.'
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function sanitizeVagueReferences(value: TimeReference): TimeReference {
  for (const side of ['s', 'e'] as TimeReferenceSide[]) {
    const monthRef = getSideRef(value, 'm', side);
    const weekRef = getSideRef(value, 'w', side);
    if (isVague(weekRef)) {
      setSideRef(value, 'w', side, undefined);
    }
    if (isVague(monthRef)) {
      if (weekRef) setSideRef(value, 'w', side, undefined);
      const dayRef = getSideRef(value, 'd', side);
      if (dayRef) setSideRef(value, 'd', side, undefined);
      const minuteRef = getSideRef(value, 'i', side);
      if (minuteRef) setSideRef(value, 'i', side, undefined);
    }
    const dayRef = getSideRef(value, 'd', side);
    if (isVague(dayRef)) {
      const minuteRef = getSideRef(value, 'i', side);
      if (minuteRef) setSideRef(value, 'i', side, undefined);
    }
  }
  return value;
}

function pruneInvalidEndReferences(value: TimeReference): TimeReference {
  // Persistence-time safety net behind validateTimeReferenceStructure (which
  // UIs use to reject bad input): drop end refs that would place the end
  // before the start instead of failing the whole write. Uses the same
  // comparison rules as validation so the two can never disagree.
  const window = extractDateWindow(value);
  if (!window) return value;

  if (hasExplicitEndDate(value) && window.end.getTime() < window.start.getTime()) {
    setSideRef(value, 'y', 'e', undefined);
    setSideRef(value, 'm', 'e', undefined);
    setSideRef(value, 'w', 'e', undefined);
    setSideRef(value, 'd', 'e', undefined);
  }

  const startMinuteRef = getSideRef(value, 'i', 's');
  const endMinuteRef = getSideRef(value, 'i', 'e');
  if (endMinuteRef) {
    // Only a same-day end minute can be reversed; across days the end minute
    // is legitimately allowed to be earlier than the start minute. Recompute
    // the window because the date prune above may have changed the end day.
    const pruned = extractDateWindow(value);
    const sameDay = pruned !== null && pruned.end.getTime() === pruned.start.getTime();
    if (sameDay && isMinutePairReversed(startMinuteRef, endMinuteRef)) {
      setSideRef(value, 'i', 'e', undefined);
    }
  }

  return value;
}

function trimImplicitEndReferences(value: TimeReference): TimeReference {
  for (const field of ['y', 'm', 'w', 'd', 'i'] as TimeReferenceField[]) {
    const startRef = getSideRef(value, field, 's');
    const endRef = getSideRef(value, field, 'e');
    if (refsEqual(startRef, endRef)) {
      setSideRef(value, field, 'e', undefined);
    }
  }
  return value;
}

export function normalizeTimeReference(
  value: TimeReference | undefined,
  options: NormalizeTimeReferenceOptions = {}
): TimeReference {
  const opts = {
    sanitizeVague: true,
    pruneInvalidEnd: true,
    trimImplicitEnds: true,
    ...options
  };

  let next = cloneTimeReference(value);

  if (opts.sanitizeVague) {
    next = sanitizeVagueReferences(next);
  }

  if (opts.pruneInvalidEnd) {
    next = pruneInvalidEndReferences(next);
  }

  if (opts.trimImplicitEnds) {
    next = trimImplicitEndReferences(next);
  }

  return cleanupEmptyFields(next);
}

export function hasAnyMinuteReference(value: TimeReference | undefined): boolean {
  return Boolean(value?.i?.s || value?.i?.e);
}

export function shouldTreatAsDateOnlyForPersistence(value: TimeReference | undefined): boolean {
  if (!value?.i?.s && !value?.i?.e) return true;
  const start = value.i?.s;
  const end = value.i?.e;
  return start?.type === 'ba' && start.v === 0 && end === undefined;
}

export function restoreVagueReferences(
  source: TimeReference | undefined,
  target: TimeReference | undefined
): TimeReference | undefined {
  if (!source || !target) return target;
  const next = cloneTimeReference(target);
  for (const key of ['y', 'm', 'w', 'd', 'i'] as TimeReferenceField[]) {
    const sourceField = source[key];
    if (!sourceField) continue;
    if (!next[key]) next[key] = {};
    if (sourceField.s?.type === 'vg') {
      next[key]!.s = cloneRef(sourceField.s);
    }
    if (sourceField.e?.type === 'vg') {
      next[key]!.e = cloneRef(sourceField.e);
    }
  }
  if (source.wm) next.wm = source.wm;
  if (typeof source.ws === 'number') next.ws = source.ws;
  return next;
}

/**
 * Legacy date-info shape accepted ONLY by canonicalizeDateInformation: carries
 * both the canonical SHORT fields (is / ds / rl / po) and the deprecated LONG
 * fields (is_status / display_as / relevance / relevance_duration_minutes /
 * relevance_infinite / pin_when_overdue) plus the rv/ri scalars. This is the
 * single place either form is read; everywhere else in the codebase reads the
 * short canonical DateInformation.
 */
export interface LegacyDateInfoInput extends DateInformation {
  is_status?: boolean;
  display_as?: string;
  relevance?: RelevanceWindow;
  relevance_duration_minutes?: number;
  relevance_infinite?: boolean;
  pin_when_overdue?: boolean;
  rv?: number;
  ri?: boolean;
}

function normalizeDisplayCode(value: unknown): 'mj' | 'mi' | 'sm' | 'n' | undefined {
  if (value === 'Major' || value === 'mj') return 'mj';
  if (value === 'Minor' || value === 'mi') return 'mi';
  if (value === 'Mini' || value === 'sm') return 'sm';
  if (value === 'None' || value === 'n') return 'n';
  return undefined;
}

/**
 * Collapse a date_info to its canonical SHORT form: `is`, `ds`, `rl`, `po`
 * (rv/ri fold into `rl`). Long fields and rv/ri are dropped. This is the one
 * client-side canonicalizer — the DB stores short-only (server ingress
 * fn::canonicalize_date_info + the one-off migration guarantee it), so readers
 * everywhere else assume short.
 */
export function canonicalizeDateInformation(input: LegacyDateInfoInput | DateInformation): DateInformation {
  const legacy = input as LegacyDateInfoInput;
  const out: DateInformation = {
    value: input.value,
    is: Boolean(legacy.is ?? legacy.is_status ?? false)
  };
  if (typeof input.offset_enabled === 'boolean') out.offset_enabled = input.offset_enabled;

  const ds = normalizeDisplayCode(legacy.ds ?? legacy.display_as);
  if (ds) out.ds = ds;

  // Relevance: prefer the rl/relevance object; else fold ri/rv scalars into rl.
  let rl = legacy.rl ?? legacy.relevance;
  if (!rl || (!rl.before && !rl.after)) {
    const infinite = legacy.relevance_infinite === true || legacy.ri === true;
    const minutes = legacy.relevance_duration_minutes ?? legacy.rv;
    if (infinite) {
      rl = { before: { type: 'inf' }, after: { type: 'inf' } };
    } else if (typeof minutes === 'number' && Number.isFinite(minutes)) {
      rl = { before: { type: 'dur', minutes }, after: { type: 'dur', minutes } };
    } else {
      rl = undefined;
    }
  }
  if (rl) out.rl = rl;

  if (legacy.pin_when_overdue === true || legacy.po === true) out.po = true;

  return out;
}

export function normalizeDateInformationForPersistence(
  dateInfo: DateInformation,
  options: NormalizeDateInformationForPersistenceOptions = {}
): DateInformation {
  const output = options.output ?? 'preserve';
  const sourceValue = cloneTimeReference(dateInfo.value);
  const next = cloneDateInformation(dateInfo);

  if (output === 'preserve') {
    next.value = normalizeTimeReference(sourceValue, options.timeReference);
    return canonicalizeDateInformation(next);
  }

  const resolveNow = options.resolveNow ?? new Date();
  const resolveContext = options.resolveContext ?? {};
  const start = resolveStart(sourceValue, resolveNow, resolveContext);
  const end = resolveEnd(sourceValue, resolveNow, resolveContext);
  const explicitEnd = hasExplicitEnd(sourceValue);
  const dateOnly = options.dateOnly ?? !hasAnyMinuteReference(sourceValue);

  const rebuilt = output === 'relative'
    ? relativeTimeReference(
        start,
        explicitEnd ? end : null,
        options.relativeAnchor ?? resolveNow,
        options.relativeAnchorType ?? 'up'
      )
    : explicitTimeReference(start, explicitEnd ? end : null);

  if (dateOnly) {
    delete rebuilt.i;
  }

  next.value = normalizeTimeReference(
    restoreVagueReferences(sourceValue, rebuilt) ?? rebuilt,
    options.timeReference
  );
  if (dateOnly) {
    delete next.value.i;
  }
  return canonicalizeDateInformation(next);
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

export function hasExplicitEnd(value: TimeReference | undefined): boolean {
  if (!value) return false;
  return Boolean(value.y?.e || value.m?.e || value.w?.e || value.d?.e || value.i?.e);
}

export function hasExplicitStartDate(value: TimeReference | undefined): boolean {
  if (!value) return false;
  return Boolean(value.y?.s || value.m?.s || value.w?.s || value.d?.s);
}

export function hasExplicitStartTime(value: TimeReference | undefined): boolean {
  if (!value) return false;
  return Boolean(value.i?.s);
}

export function hasExplicitEndDate(value: TimeReference | undefined): boolean {
  if (!value) return false;
  return Boolean(value.y?.e || value.m?.e || value.w?.e || value.d?.e);
}

export function hasExplicitEndTime(value: TimeReference | undefined): boolean {
  if (!value) return false;
  return Boolean(value.i?.e);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function monthName(m: number): string {
  return [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ][m - 1] ?? 'Unknown';
}

function formatMinute(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

export function formatDateReferenceLabel(value: TimeReference | undefined, side: 'start' | 'end'): string {
  if (!value) return '';
  const s = side === 'start' ? 's' : 'e';
  const yr = value.y?.[s];
  const mo = value.m?.[s];
  const wk = value.w?.[s];
  const da = value.d?.[s];

  // For end side, fall back to start year/month/day when end is absent
  const fallbackYr = side === 'end' ? value.y?.s : undefined;
  const fallbackMo = side === 'end' ? value.m?.s : undefined;
  const fallbackWk = side === 'end' ? value.w?.s : undefined;
  const fallbackDa = side === 'end' ? value.d?.s : undefined;

  const yv = yr?.type === 'ba' ? yr.v : (fallbackYr?.type === 'ba' ? fallbackYr.v : null);
  const mv = mo?.type === 'ba' ? mo.v : (fallbackMo?.type === 'ba' ? fallbackMo.v : null);
  const wv = wk?.type === 'ba' ? wk.v : (fallbackWk?.type === 'ba' ? fallbackWk.v : null);
  const dv = da?.type === 'ba' ? da.v : (fallbackDa?.type === 'ba' ? fallbackDa.v : null);

  if (mo?.type === 'vg') {
    const info = VAGUE_MONTHS[mo.t as VagueMonthCode];
    if (info) return info.label + (yv !== null ? ` ${yv}` : '');
  }

  if (da?.type === 'vg') {
    const info = VAGUE_DAYS[da.t as VagueDayCode];
    if (info) {
      if (mv !== null) return `${monthName(mv)} ${info.label}${yv !== null ? `, ${yv}` : ''}`;
      return info.label;
    }
  }

  if (wv !== null) {
    const mode = weekModeFor(value);
    const modeLabel = mode === 'iso' ? 'ISO week' : mode === 'row' ? 'Week row' : 'Week';
    if (mv !== null && dv !== null) return `${monthName(mv)} ${modeLabel} ${wv}, day ${dv}${yv !== null ? `, ${yv}` : ''}`;
    if (mv !== null) return `${monthName(mv)} ${modeLabel} ${wv}${yv !== null ? `, ${yv}` : ''}`;
    if (dv !== null) return `${modeLabel} ${wv}, day ${dv}${yv !== null ? `, ${yv}` : ''}`;
    return `${modeLabel} ${wv}${yv !== null ? ` ${yv}` : ''}`;
  }

  if (yv !== null && mv !== null && dv !== null) {
    return `${monthName(mv)} ${dv}, ${yv}`;
  }
  if (mv !== null && dv !== null) {
    return `${monthName(mv)} ${dv}`;
  }
  if (yv !== null && mv !== null) {
    return `${monthName(mv)} ${yv}`;
  }
  if (yv !== null) {
    return String(yv);
  }

  return '';
}

export function formatTimeReferenceLabel(value: TimeReference | undefined, side: 'start' | 'end'): string {
  if (!value) return '';
  const s = side === 'start' ? 's' : 'e';
  const minuteRef = value.i?.[s];

  if (minuteRef?.type === 'vg') {
    const info = VAGUE_MINUTES[minuteRef.t as VagueMinuteCode];
    return info?.label ?? minuteRef.t;
  }

  if (minuteRef?.type === 'ba') {
    return formatMinute(minuteRef.v);
  }

  return '';
}

export function formatTimeReferenceRangeLabel(value: TimeReference | undefined): string {
  if (!value) return 'Scheduled';

  const hasEnd = hasExplicitEnd(value);
  const startDateLabel = formatDateReferenceLabel(value, 'start');
  const startTimeLabel = formatTimeReferenceLabel(value, 'start');
  const endDateLabel = formatDateReferenceLabel(value, 'end');
  const endTimeLabel = formatTimeReferenceLabel(value, 'end');

  // Helper to build a same-year range string like "May 13 – May 15, 2026"
  function formatDateRange(start: string, end: string): string {
    const startYearMatch = start.match(/, (\d{4})$/);
    const endYearMatch = end.match(/, (\d{4})$/);
    if (startYearMatch && endYearMatch && startYearMatch[1] === endYearMatch[1]) {
      const startWithoutYear = start.replace(/, \d{4}$/, '');
      return `${startWithoutYear} – ${end}`;
    }
    return `${start} – ${end}`;
  }

  // Date only (no time at all)
  if (!startTimeLabel && !endTimeLabel) {
    if (hasEnd && endDateLabel && endDateLabel !== startDateLabel) {
      return formatDateRange(startDateLabel, endDateLabel);
    }
    return startDateLabel || 'Scheduled';
  }

  // Same date with time range (no end date, or same date)
  if (!hasEnd || startDateLabel === endDateLabel || (!endDateLabel && endTimeLabel)) {
    if (startTimeLabel && endTimeLabel) {
      return `${startDateLabel} · ${startTimeLabel} – ${endTimeLabel}`;
    }
    if (startTimeLabel) {
      return `${startDateLabel} · ${startTimeLabel}`;
    }
    return startDateLabel || 'Scheduled';
  }

  // Multi-day with times
  if (startTimeLabel && endTimeLabel) {
    return `${startDateLabel} · ${startTimeLabel} – ${endDateLabel} · ${endTimeLabel}`;
  }

  // Multi-day without times (shouldn't happen here but handle)
  if (hasEnd && endDateLabel) {
    return formatDateRange(startDateLabel, endDateLabel);
  }

  return startDateLabel || 'Scheduled';
}

// ---------------------------------------------------------------------------
// DateInformation helpers
// ---------------------------------------------------------------------------

export function cloneDateInformation(
  value: DateInformation | null | undefined,
  fallbackDate?: Date
): DateInformation {
  if (value) {
    return {
      ...value,
      value: cloneTimeReference(value.value)
    };
  }
  if (fallbackDate) {
    return {
      value: {
        y: { s: { type: 'ba', v: fallbackDate.getFullYear() } },
        m: { s: { type: 'ba', v: fallbackDate.getMonth() + 1 } },
        d: { s: { type: 'ba', v: fallbackDate.getDate() } }
      },
      is: false,
      ds: 'mj'
    };
  }
  return {
    value: {},
    is: false
  };
}

export function defaultCalendarDateInfo(date: Date): DateInformation {
  return {
    value: {
      y: { s: { type: 'ba', v: date.getFullYear() } },
      m: { s: { type: 'ba', v: date.getMonth() + 1 } },
      d: { s: { type: 'ba', v: date.getDate() } }
    },
    is: false,
    ds: 'mj'
  };
}

export function applyDisplayFlags(
  dateInfo: DateInformation,
  session: { formIsStatus?: boolean; formIsMinor?: boolean }
): DateInformation {
  return {
    ...dateInfo,
    is: session.formIsStatus ?? dateInfo.is ?? false,
    ds: session.formIsMinor ? 'mi' : 'mj'
  };
}
