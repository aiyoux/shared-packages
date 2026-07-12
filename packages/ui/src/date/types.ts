// Date specific additionals.
//
// CANONICAL SHORT FORM ONLY. The stored (DB) and in-code shape uses the short
// field names exclusively: `is` (status), `ds` (display), `rl` (relevance
// window), `po` (pin-when-overdue). The legacy LONG fields (is_status /
// display_as / relevance / relevance_duration_minutes / relevance_infinite /
// pin_when_overdue) and the `rv`/`ri` scalars are DEAD everywhere except the
// single canonicalizer (`canonicalizeDateInformation` in
// time-reference-normalize.ts, input typed `LegacyDateInfoInput`). The server
// ingress (fn::canonicalize_date_info) and a one-off migration guarantee the
// DB never stores the long form, so all readers assume short.
export interface DateInformation {
  value: TimeReference;
  /** Status flag (this date represents a status milestone). */
  is?: boolean;
  /**
   * UI intent marker for anchor-relative dates. A zero-day offset resolves the
   * same as the bare anchor, so this preserves whether the offset editor was
   * explicitly enabled when `value` itself cannot distinguish those states.
   */
  offset_enabled?: boolean;
  /** Display prominence: Major / Minor / Mini / None. */
  ds?: 'mj' | 'mi' | 'sm' | 'n';
  /**
   * Relevance window: separate bounds for the `before` (how early the item
   * surfaces, relative to its resolved start) and `after` (how long it lingers,
   * relative to its resolved end) sides. Supersedes the legacy rv/ri scalars,
   * which the canonicalizer folds into this.
   */
  rl?: RelevanceWindow;
  /** Pin the item while overdue. */
  po?: boolean;
}

export type RelevancePeriodUnit = 'day' | 'week' | 'month' | 'year';

/**
 * One side of a relevance window. A bound answers "how far from the anchor is
 * this item still relevant?" in one of three ways:
 *  - `dur`: a fixed number of minutes (the legacy behavior).
 *  - `cal`: snap to the calendar period (day/week/month/year) containing the
 *    anchor — e.g. `{ type: 'cal', unit: 'day' }` on the `after` side keeps an
 *    item relevant until the end of its due date's calendar day.
 *  - `inf`: unbounded on this side.
 */
export type RelevanceBound =
  | { type: 'dur'; minutes: number }
  | { type: 'cal'; unit: RelevancePeriodUnit }
  | { type: 'inf' };

export interface RelevanceWindow {
  /** Bound applied to the resolved start (controls early surfacing). */
  before?: RelevanceBound;
  /** Bound applied to the resolved end (controls lingering after due). */
  after?: RelevanceBound;
}

export type BaseOrVagueReference<VRT, T> =
  | { type: 'ba', v: T, a?: T } // Base
  | { type: 'vg', t: VRT }       // Vague
  | { type: 'of', v: number, a: 'nw' | 'up' | 'pr' }; // Offset

export interface StartOrEnd<VRT, T> {
  s?: BaseOrVagueReference<VRT, T>;
  e?: BaseOrVagueReference<VRT, T>;
}

export type WeekModeCode = 'ord' | 'iso' | 'row';

export interface TimeReference {
  y?: StartOrEnd<string, number>; // year
  m?: StartOrEnd<string, number>; // month
  w?: StartOrEnd<string, number>; // week
  d?: StartOrEnd<string, number>; // day
  i?: StartOrEnd<string, number>; // minutes
  wm?: WeekModeCode; // week mode: ordinal, ISO, or stored calendar row
  ws?: number; // stored first day of week for row mode, 0 = Sun ... 6 = Sat
}

export interface DateReference {
  date_info: DateInformation;
}