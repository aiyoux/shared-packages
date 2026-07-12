// Resolves a TimeReference to a concrete Date — ported from wisewords
// `TimeReference::resolve_side` in crates/calendar_domain/src/helpers/definitions.rs.
//
// Key deviation from Rust: vague references resolve to the RANGE edge
// appropriate to the side being computed (start → low, end → high) instead
// of the midpoint. This makes vague items have a real active window on the
// exec landing (a Morning item is active 07:00–12:00, not just at 09:00).

import type { BaseOrVagueReference, StartOrEnd, TimeReference } from './types.ts';
import {
  vagueMinuteValue,
  vagueDayValue,
  vagueMonthValue,
  VAGUE_MONTHS,
  type VagueMinuteCode,
  type VagueDayCode,
  type VagueMonthCode
} from './vague-time.ts';
import { days_between } from './time.ts';
import {
  addDays,
  clamp,
  dateFromDayOfYear,
  resolvedWeekRangeForRef,
  weekModeFor,
  weekStartFor
} from './time-week.ts';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Side = 'start' | 'end';

function pickSide<VRT, T>(
  field: StartOrEnd<VRT, T> | undefined,
  side: Side
): BaseOrVagueReference<VRT, T> | undefined {
  if (!field) return undefined;
  if (side === 'start') return field.s;
  // End-side falls back to start if not explicitly set — mirrors Rust
  // `resolve_side` fallback for the end branch.
  return field.e ?? field.s;
}

function cloneDate(d: Date): Date {
  return new Date(d.getTime());
}

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

/** Days in the month of `d`, using `new Date(y, m+1, 0)` trick. */
function lastDayOfMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function clampDayToMonth(d: Date, day: number): number {
  return Math.min(day, lastDayOfMonth(d));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolveContext {
  /** Fallback anchor for `ParentResolved` and `UserProvided` offset anchors. */
  userProvided?: Date;
  /** The closest dated ancestor's already-resolved start; used for `pr` anchors. */
  parentResolved?: Date;
}

export type DateScopeKind = 'instant' | 'timed-window' | 'day';

export interface ResolvedTimeWindow {
  start: Date;
  end: Date;
  kind: DateScopeKind;
  hasExplicitMinute: boolean;
}

/** Resolve the start side of a TimeReference against `now`. */
export function resolveStart(
  tr: TimeReference | undefined,
  now: Date,
  ctx: ResolveContext = {}
): Date {
  return resolveSide(tr, 'start', now, ctx);
}

/** Resolve the end side of a TimeReference against `now`. */
export function resolveEnd(
  tr: TimeReference | undefined,
  now: Date,
  ctx: ResolveContext = {}
): Date {
  return resolveSide(tr, 'end', now, ctx);
}

export function resolveTimeWindow(
  tr: TimeReference | undefined,
  now: Date,
  ctx: ResolveContext = {}
): ResolvedTimeWindow {
  const start = resolveStart(tr, now, ctx);
  const end = resolveEnd(tr, now, ctx);
  const hasExplicitMinute = Boolean(tr?.i?.s || tr?.i?.e);
  const hasExplicitDate = Boolean(tr?.y?.s || tr?.y?.e || tr?.m?.s || tr?.m?.e || tr?.w?.s || tr?.w?.e || tr?.d?.s || tr?.d?.e);

  if (hasExplicitDate && !hasExplicitMinute) {
    const dayStart = new Date(start);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(end);
    dayEnd.setHours(0, 0, 0, 0);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return {
      start: dayStart,
      end: dayEnd,
      kind: 'day',
      hasExplicitMinute
    };
  }

  return {
    start,
    end,
    kind: end.getTime() === start.getTime() ? 'instant' : 'timed-window',
    hasExplicitMinute
  };
}

function resolveSide(
  tr: TimeReference | undefined,
  side: Side,
  now: Date,
  ctx: ResolveContext
): Date {
  let resolved = cloneDate(now);
  if (!tr) return resolved;

  // 1 — Year
  const yr = pickSide(tr.y, side);
  if (yr) {
    if (yr.type === 'ba') {
      resolved.setFullYear(yr.v as number);
    } else if (yr.type === 'vg') {
      // VagueYear is not meaningful in isolation — skip and leave year as-is.
    } else if (yr.type === 'of') {
      const base = anchorDate(yr.a, now, ctx);
      resolved.setFullYear(base.getFullYear() + yr.v);
    }
  }

  // 2 — Month (1-indexed in our domain, 0-indexed in JS Date)
  const mr = pickSide(tr.m, side);
  if (mr) {
    if (mr.type === 'ba') {
      resolved.setMonth((mr.v as number) - 1);
    } else if (mr.type === 'vg') {
      const code = mr.t as VagueMonthCode;
      const v = vagueMonthValue(code, side);
      resolved.setMonth(v - 1);
      // Winter's range [12, 2] spans the year boundary: the end-side value of
      // Feb refers to the *following* year, not the same one.
      if (VAGUE_MONTHS[code].wraps && side === 'end') {
        resolved.setFullYear(resolved.getFullYear() + 1);
      }
    } else if (mr.type === 'of') {
      const base = anchorDate(mr.a, now, ctx);
      const totalMonths = base.getFullYear() * 12 + base.getMonth() + mr.v;
      resolved.setFullYear(Math.floor(totalMonths / 12));
      resolved.setMonth(totalMonths % 12);
    }
  }

  // 3 — Week
  const wr = pickSide(tr.w, side);
  let selectedWeekStart: Date | null = null;
  if (wr) {
    if (wr.type === 'ba') {
      const month = mr?.type === 'ba' || mr?.type === 'vg' ? resolved.getMonth() + 1 : null;
      const range = resolvedWeekRangeForRef(
        resolved.getFullYear(),
        month,
        wr as BaseOrVagueReference<string, number>,
        weekModeFor(tr),
        weekStartFor(tr),
        side
      );
      selectedWeekStart = cloneDate(range.start);
      resolved = cloneDate(side === 'start' ? range.start : range.end);
    } else if (wr.type === 'of') {
      const base = anchorDate(wr.a, now, ctx);
      const shifted = new Date(base.getTime());
      shifted.setDate(shifted.getDate() + wr.v * 7);
      resolved.setFullYear(shifted.getFullYear());
      resolved.setMonth(shifted.getMonth());
      resolved.setDate(shifted.getDate());
      selectedWeekStart = cloneDate(resolved);
    }
  }

  // 4 — Day
  const dr = pickSide(tr.d, side);
  if (dr) {
    if (dr.type === 'ba') {
      if (selectedWeekStart) {
        resolved = addDays(selectedWeekStart, clamp(dr.v as number, 1, 7) - 1);
      } else if (!mr) {
        resolved = dateFromDayOfYear(resolved.getFullYear(), dr.v as number);
      } else {
        resolved.setDate(clampDayToMonth(resolved, dr.v as number));
      }
    } else if (dr.type === 'vg') {
      const v = vagueDayValue(dr.t as VagueDayCode, side);
      // Vague ranges end at day 31, but short months would silently overflow
      // (setDate(31) on June rolls into July). Clamp to the real month max.
      if (selectedWeekStart) {
        resolved = addDays(selectedWeekStart, clamp(v, 1, 7) - 1);
      } else {
        resolved.setDate(clampDayToMonth(resolved, v));
      }
    } else if (dr.type === 'of') {
      const base = anchorDate(dr.a, now, ctx);
      const shifted = new Date(base.getTime());
      shifted.setDate(shifted.getDate() + dr.v);
      resolved.setFullYear(shifted.getFullYear());
      resolved.setMonth(shifted.getMonth());
      resolved.setDate(shifted.getDate());
    }
  }

  // 5 — Minutes (total minutes from midnight)
  const ir = pickSide(tr.i, side);
  if (ir) {
    if (ir.type === 'ba') {
      const total = ir.v as number;
      resolved.setHours(Math.floor(total / 60), total % 60, 0, 0);
    } else if (ir.type === 'vg') {
      const total = vagueMinuteValue(ir.t as VagueMinuteCode, side);
      resolved.setHours(Math.floor(total / 60), total % 60, 0, 0);
    } else if (ir.type === 'of') {
      // Minute-of offset specifies a time of day (minutes past midnight of the
      // anchor, i.e. `base.getHours()*60 + base.getMinutes() + ir.v`). It
      // MUST NOT override the Y/M/D already computed from the day/month/year
      // fields — otherwise a child with `d.s = up/+1, i.s = up/+480` would
      // collapse back onto the plan anchor's day. Instead, take the minute-
      // of-day (modulo 24h) from the anchor-based arithmetic and preserve
      // `resolved`'s date, rolling the day forward only when the offset
      // genuinely crosses midnight.
      const base = anchorDate(ir.a, now, ctx);
      const baseMinutes = base.getHours() * 60 + base.getMinutes();
      const totalMinutes = baseMinutes + ir.v;
      const dayDelta = Math.floor(totalMinutes / 1440);
      const minuteOfDay = ((totalMinutes % 1440) + 1440) % 1440;
      if (dayDelta !== 0) {
        resolved.setDate(resolved.getDate() + dayDelta);
      }
      resolved.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
    }
  } else {
    const inheritedTimeAnchor =
      yr?.type === 'of' ? anchorDate(yr.a, now, ctx) :
      mr?.type === 'of' ? anchorDate(mr.a, now, ctx) :
      wr?.type === 'of' ? anchorDate(wr.a, now, ctx) :
      dr?.type === 'of' ? anchorDate(dr.a, now, ctx) :
      null;

    if (inheritedTimeAnchor) {
      resolved.setHours(
        inheritedTimeAnchor.getHours(),
        inheritedTimeAnchor.getMinutes(),
        0,
        0
      );
    } else {
      // No minute field at all — collapse to midnight so urgency ranking
      // treats date-only items as "all-day-at-00:00". Callers that need
      // whole-day semantics should pair resolveStart with resolveEnd of the
      // same TimeReference.
      resolved.setHours(0, 0, 0, 0);
    }
  }

  return resolved;
}

function anchorDate(
  anchor: 'nw' | 'up' | 'pr',
  now: Date,
  ctx: ResolveContext
): Date {
  switch (anchor) {
    case 'nw':
      return now;
    case 'up':
      return ctx.userProvided ?? now;
    case 'pr':
      return ctx.parentResolved ?? ctx.userProvided ?? now;
  }
}

function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function hasExplicitEndField(tr: TimeReference | undefined): boolean {
  return Boolean(tr?.y?.e || tr?.m?.e || tr?.w?.e || tr?.d?.e || tr?.i?.e);
}

function explicitDateFields(start: Date, end?: Date | null): Omit<TimeReference, 'i'> {
  const finish = end ?? null;
  const hasExplicitEnd = Boolean(finish && finish.getTime() !== start.getTime());

  return {
    y: {
      s: { type: 'ba', v: start.getFullYear() },
      ...(hasExplicitEnd ? { e: { type: 'ba', v: finish!.getFullYear() } } : {})
    },
    m: {
      s: { type: 'ba', v: start.getMonth() + 1 },
      ...(hasExplicitEnd ? { e: { type: 'ba', v: finish!.getMonth() + 1 } } : {})
    },
    d: {
      s: { type: 'ba', v: start.getDate() },
      ...(hasExplicitEnd ? { e: { type: 'ba', v: finish!.getDate() } } : {})
    }
  };
}

function anchorTypeForRelativeDateField(
  tr: TimeReference | undefined
): 'nw' | 'up' | 'pr' | null {
  for (const key of ['y', 'm', 'w', 'd'] as const) {
    const startRef = tr?.[key]?.s;
    const endRef = tr?.[key]?.e;
    if (startRef?.type === 'of') return startRef.a;
    if (endRef?.type === 'of') return endRef.a;
  }
  return null;
}

function materializeMinuteRef(
  ref: BaseOrVagueReference<VagueMinuteCode, number> | undefined,
  resolved: Date
): BaseOrVagueReference<VagueMinuteCode, number> | undefined {
  if (!ref) return undefined;
  if (ref.type === 'vg') return cloneRef(ref);
  if (ref.type === 'ba') return cloneRef(ref);
  return { type: 'ba', v: minuteOfDay(resolved) };
}

export function explicitTimeReference(start: Date, end?: Date | null): TimeReference {
  const finish = end ?? start;
  const hasExplicitEnd = Boolean(end && end.getTime() !== start.getTime());
  const startMinute = minuteOfDay(start);
  const endMinute = minuteOfDay(finish);

  return {
    ...explicitDateFields(start, end),
    i: {
      s: { type: 'ba', v: startMinute },
      ...(hasExplicitEnd ? { e: { type: 'ba', v: endMinute } } : {})
    }
  };
}

export function relativeTimeReference(
  start: Date,
  end: Date | null | undefined,
  anchor: Date,
  anchorType: 'up' | 'pr' = 'up'
): TimeReference {
  const finish = end ?? start;
  const hasExplicitEnd = Boolean(end && end.getTime() !== start.getTime());

  const startDay = new Date(start);
  startDay.setHours(0, 0, 0, 0);
  const finishDay = new Date(finish);
  finishDay.setHours(0, 0, 0, 0);
  const anchorDay = new Date(anchor);
  anchorDay.setHours(0, 0, 0, 0);

  return {
    d: {
      s: { type: 'of', v: days_between(anchorDay, startDay), a: anchorType },
      ...(hasExplicitEnd ? { e: { type: 'of', v: days_between(anchorDay, finishDay), a: anchorType } } : {})
    },
    i: {
      s: { type: 'ba', v: minuteOfDay(start) },
      ...(hasExplicitEnd ? { e: { type: 'ba', v: minuteOfDay(finish) } } : {})
    }
  };
}

export function materializeTimeReference(
  tr: TimeReference | undefined,
  now: Date,
  ctx: ResolveContext = {},
  options?: {
    inheritedParentMinuteRange?: StartOrEnd<VagueMinuteCode, number> | undefined;
  }
): TimeReference {
  const start = resolveStart(tr, now, ctx);
  const end = resolveEnd(tr, now, ctx);
  const hasImplicitDateRange =
    start.getFullYear() !== end.getFullYear() ||
    start.getMonth() !== end.getMonth() ||
    start.getDate() !== end.getDate();
  const hasExplicitEnd = hasExplicitEndField(tr) || hasImplicitDateRange;
  const base: TimeReference = explicitDateFields(start, hasExplicitEnd ? end : null);

  const startMinuteRef = materializeMinuteRef(pickSide(tr?.i, 'start') as BaseOrVagueReference<VagueMinuteCode, number> | undefined, start);
  const endMinuteRef = materializeMinuteRef(pickSide(tr?.i, 'end') as BaseOrVagueReference<VagueMinuteCode, number> | undefined, end);

  if (startMinuteRef || endMinuteRef) {
    base.i = {
      ...(startMinuteRef ? { s: startMinuteRef } : {}),
      ...(hasExplicitEnd && endMinuteRef ? { e: endMinuteRef } : {})
    };
    return base;
  }

  if (anchorTypeForRelativeDateField(tr) === 'pr' && options?.inheritedParentMinuteRange) {
    const inherited = cloneStartOrEnd(options.inheritedParentMinuteRange);
    if (inherited?.s || inherited?.e) {
      base.i = inherited;
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Convenience: does this TimeReference have any resolvable date at all?
// ---------------------------------------------------------------------------

/**
 * Returns true if the TimeReference has at least one field set — i.e. its
 * resolution will produce something other than the unmodified `now` copy.
 * Used by the exec landing to decide whether an item has its own date
 * (hoist) or inherits from a dated ancestor.
 */
export function hasAnyDateField(tr: TimeReference | undefined): boolean {
  if (!tr) return false;
  return Boolean(
    tr.y?.s || tr.y?.e ||
    tr.m?.s || tr.m?.e ||
    tr.w?.s || tr.w?.e ||
    tr.d?.s || tr.d?.e ||
    tr.i?.s || tr.i?.e
  );
}
