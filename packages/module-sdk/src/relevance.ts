// Unified relevance resolution.
//
// Replaces the scattered `relevanceMinutes` / `isRelevanceInfinite` /
// `pinWhenOverdue` trio with a single resolver that turns an item's relevance
// configuration (plus a user-level default) into two absolute epoch thresholds:
//
//   beforeStart — earliest instant the item is considered relevant (≤ start)
//   afterEnd    — latest instant the item is considered relevant (≥ end)
//
// Each side is resolved independently (before/after asymmetry) through the
// chain: item bound → user-default bound → builtin default. A bound is one of:
//   - dur: fixed minutes (legacy behavior)
//   - cal: snap to the calendar period (day/week/month/year) of the anchor
//   - inf: unbounded
//
// The builtin default is "same calendar day" on both sides, so a dated item is
// relevant for the whole of its due date and no longer.

import type {
  DateInformation,
  RelevanceBound,
  RelevancePeriodUnit,
  RelevanceWindow,
  TimeReference
} from './types.ts';
import { addDays, firstDayOfWeek, weekModeFor, weekStartFor } from './time-week.ts';

const MINUTE_MS = 60_000;

/** Builtin fallback when neither the item nor the user sets a side. */
export const BUILTIN_RELEVANCE: Required<RelevanceWindow> = {
  before: { type: 'cal', unit: 'day' },
  after: { type: 'cal', unit: 'day' }
};

export interface ResolvedRelevance {
  /** Earliest relevant instant (epoch ms); -Infinity when unbounded. */
  beforeStart: number;
  /** Latest relevant instant, inclusive (epoch ms); +Infinity when unbounded. */
  afterEnd: number;
  pinWhenOverdue: boolean;
}

/**
 * Read an item's canonical relevance window (`rl`). Returns `undefined` when
 * the item carries no relevance intent of its own (so the caller can fall
 * through to user defaults). Legacy rv/ri are folded into `rl` at persistence.
 */
export function readRelevanceWindow(info: DateInformation): RelevanceWindow | undefined {
  // Canonical short form only: rv/ri were folded into `rl` at persistence
  // (canonicalizeDateInformation) and by the one-off migration.
  const explicit = info.rl;
  if (explicit && (explicit.before || explicit.after)) return explicit;
  return undefined;
}

export function readPinWhenOverdue(info: DateInformation): boolean {
  return info.po === true;
}

function pickBound(
  side: 'before' | 'after',
  item: RelevanceWindow | undefined,
  defaults: RelevanceWindow | null | undefined
): RelevanceBound {
  return item?.[side] ?? defaults?.[side] ?? BUILTIN_RELEVANCE[side];
}

/** Start of the calendar period containing `d`, honoring the item's week config. */
function startOfPeriod(d: Date, unit: RelevancePeriodUnit, tr: TimeReference | undefined): Date {
  switch (unit) {
    case 'day':
      return atMidnight(d);
    case 'week': {
      const weekStart = weekModeFor(tr) === 'iso' ? 1 : weekStartFor(tr);
      return firstDayOfWeek(d, weekStart);
    }
    case 'month':
      return new Date(d.getFullYear(), d.getMonth(), 1);
    case 'year':
      return new Date(d.getFullYear(), 0, 1);
  }
}

/** Exclusive end (start of the next period) of the calendar period containing `d`. */
function endOfPeriodExclusive(d: Date, unit: RelevancePeriodUnit, tr: TimeReference | undefined): Date {
  switch (unit) {
    case 'day': {
      const next = atMidnight(d);
      next.setDate(next.getDate() + 1);
      return next;
    }
    case 'week':
      return addDays(startOfPeriod(d, 'week', tr), 7);
    case 'month':
      return new Date(d.getFullYear(), d.getMonth() + 1, 1);
    case 'year':
      return new Date(d.getFullYear() + 1, 0, 1);
  }
}

function atMidnight(d: Date): Date {
  const next = new Date(d.getTime());
  next.setHours(0, 0, 0, 0);
  return next;
}

function resolveBeforeStart(bound: RelevanceBound, start: Date, tr: TimeReference | undefined): number {
  if (bound.type === 'inf') return -Infinity;
  if (bound.type === 'dur') return start.getTime() - bound.minutes * MINUTE_MS;
  return startOfPeriod(start, bound.unit, tr).getTime();
}

function resolveAfterEnd(bound: RelevanceBound, end: Date, tr: TimeReference | undefined): number {
  if (bound.type === 'inf') return Infinity;
  if (bound.type === 'dur') return end.getTime() + bound.minutes * MINUTE_MS;
  // `end` is the resolved window's half-open upper bound: for an all-day item
  // it's the *next* day's midnight (e.g. an item due Apr 15 has end = Apr 16
  // 00:00). Snapping that exclusive instant to its calendar period would land
  // one period late — the after-window would bleed into the following day and
  // a previous-day item would still read as relevant today. Snap from the last
  // *inclusive* instant (end − 1ms) instead so a same-day window stays same-day.
  const inclusiveEnd = new Date(end.getTime() - 1);
  // Inclusive last instant of the calendar period (next-period start minus 1ms).
  return endOfPeriodExclusive(inclusiveEnd, bound.unit, tr).getTime() - 1;
}

/**
 * Resolve an item's effective relevance thresholds against its resolved
 * start/end window. `defaults` is the user-level (radar) fallback window.
 */
export function resolveRelevance(
  info: DateInformation,
  resolved: { start: Date; end: Date },
  defaults?: RelevanceWindow | null
): ResolvedRelevance {
  const item = readRelevanceWindow(info);
  const tr = info.value;

  const before = pickBound('before', item, defaults);
  const after = pickBound('after', item, defaults);

  return {
    beforeStart: resolveBeforeStart(before, resolved.start, tr),
    afterEnd: resolveAfterEnd(after, resolved.end, tr),
    pinWhenOverdue: readPinWhenOverdue(info)
  };
}
