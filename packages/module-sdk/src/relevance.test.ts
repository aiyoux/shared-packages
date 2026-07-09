import { describe, expect, it } from 'vitest';
import type { DateInformation, RelevanceWindow, TimeReference } from './types.ts';
import {
  BUILTIN_RELEVANCE,
  readRelevanceWindow,
  resolveRelevance
} from './relevance.ts';
import { canonicalizeDateInformation } from './time-reference-normalize.ts';

const MIN = 60_000;

function infoWith(extra: Record<string, unknown>, value: TimeReference = {}): DateInformation {
  return { value, is: false, ...extra } as DateInformation;
}

// A resolved window: Wed 2026-04-15, 09:00–10:00 local.
const start = new Date(2026, 3, 15, 9, 0, 0, 0);
const end = new Date(2026, 3, 15, 10, 0, 0, 0);
const resolved = { start, end };

describe('readRelevanceWindow (legacy → canonical)', () => {
  it('returns undefined when the item carries no relevance intent', () => {
    expect(readRelevanceWindow(infoWith({}))).toBeUndefined();
  });

  it('reads the canonical rl window', () => {
    const window: RelevanceWindow = { before: { type: 'cal', unit: 'week' }, after: { type: 'dur', minutes: 30 } };
    expect(readRelevanceWindow(infoWith({ rl: window }))).toBe(window);
  });
});

describe('canonicalizeDateInformation — legacy relevance folding', () => {
  it('folds legacy rv / relevance_duration_minutes into a symmetric dur rl', () => {
    expect(canonicalizeDateInformation(infoWith({ rv: 60 })).rl).toEqual({
      before: { type: 'dur', minutes: 60 },
      after: { type: 'dur', minutes: 60 }
    });
    expect(canonicalizeDateInformation(infoWith({ relevance_duration_minutes: 90 })).rl).toEqual({
      before: { type: 'dur', minutes: 90 },
      after: { type: 'dur', minutes: 90 }
    });
  });

  it('folds legacy ri / relevance_infinite into inf on both sides', () => {
    expect(canonicalizeDateInformation(infoWith({ ri: true })).rl).toEqual({
      before: { type: 'inf' },
      after: { type: 'inf' }
    });
  });

  it('prefers the rl/relevance object over legacy scalars and drops long fields', () => {
    const window: RelevanceWindow = { before: { type: 'cal', unit: 'week' }, after: { type: 'dur', minutes: 30 } };
    const out = canonicalizeDateInformation(infoWith({ rl: window, rv: 60 }));
    expect(out.rl).toEqual(window);
    // long fields and scalars are gone
    expect((out as Record<string, unknown>).relevance).toBeUndefined();
    expect((out as Record<string, unknown>).rv).toBeUndefined();
    expect((out as Record<string, unknown>).relevance_duration_minutes).toBeUndefined();
  });
});

describe('resolveRelevance — bound resolution', () => {
  it('dur bounds offset from start/end by minutes', () => {
    const r = resolveRelevance(infoWith({ rl: { before: { type: 'dur', minutes: 30 }, after: { type: 'dur', minutes: 45 } } }), resolved);
    expect(r.beforeStart).toBe(start.getTime() - 30 * MIN);
    expect(r.afterEnd).toBe(end.getTime() + 45 * MIN);
  });

  it('inf bounds are unbounded', () => {
    const r = resolveRelevance(infoWith({ rl: { before: { type: 'inf' }, after: { type: 'inf' } } }), resolved);
    expect(r.beforeStart).toBe(-Infinity);
    expect(r.afterEnd).toBe(Infinity);
  });

  it('cal:day snaps before→midnight of start, after→last ms of end day', () => {
    const r = resolveRelevance(infoWith({ rl: { before: { type: 'cal', unit: 'day' }, after: { type: 'cal', unit: 'day' } } }), resolved);
    expect(r.beforeStart).toBe(new Date(2026, 3, 15, 0, 0, 0, 0).getTime());
    expect(r.afterEnd).toBe(new Date(2026, 3, 16, 0, 0, 0, 0).getTime() - 1);
  });

  it('cal:week snaps to the Monday-started week containing the anchor (default mode)', () => {
    const r = resolveRelevance(infoWith({ rl: { before: { type: 'cal', unit: 'week' }, after: { type: 'cal', unit: 'week' } } }), resolved);
    // Wed Apr 15 2026 → week is Mon Apr 13 .. Sun Apr 19.
    expect(r.beforeStart).toBe(new Date(2026, 3, 13, 0, 0, 0, 0).getTime());
    expect(r.afterEnd).toBe(new Date(2026, 3, 20, 0, 0, 0, 0).getTime() - 1);
  });

  it('cal:week honors a custom week-start (row mode, Sunday)', () => {
    const value: TimeReference = { wm: 'row', ws: 0 };
    const r = resolveRelevance(
      infoWith({ rl: { before: { type: 'cal', unit: 'week' } } }, value),
      { start: new Date(2026, 3, 15, 9, 0), end: new Date(2026, 3, 15, 10, 0) }
    );
    // Sunday-started week containing Wed Apr 15 → Sun Apr 12.
    expect(r.beforeStart).toBe(new Date(2026, 3, 12, 0, 0, 0, 0).getTime());
  });

  it('cal:month snaps to month edges (handles month length)', () => {
    const feb = { start: new Date(2026, 1, 10, 9, 0), end: new Date(2026, 1, 10, 10, 0) };
    const r = resolveRelevance(infoWith({ rl: { before: { type: 'cal', unit: 'month' }, after: { type: 'cal', unit: 'month' } } }), feb);
    expect(r.beforeStart).toBe(new Date(2026, 1, 1, 0, 0, 0, 0).getTime());
    // 2026 is not a leap year → Feb has 28 days; exclusive end = Mar 1.
    expect(r.afterEnd).toBe(new Date(2026, 2, 1, 0, 0, 0, 0).getTime() - 1);
  });

  it('cal:year snaps to year edges', () => {
    const r = resolveRelevance(infoWith({ rl: { before: { type: 'cal', unit: 'year' }, after: { type: 'cal', unit: 'year' } } }), resolved);
    expect(r.beforeStart).toBe(new Date(2026, 0, 1, 0, 0, 0, 0).getTime());
    expect(r.afterEnd).toBe(new Date(2027, 0, 1, 0, 0, 0, 0).getTime() - 1);
  });

  it('reads pinWhenOverdue from the canonical po flag', () => {
    expect(resolveRelevance(infoWith({ po: true }), resolved).pinWhenOverdue).toBe(true);
    expect(resolveRelevance(infoWith({}), resolved).pinWhenOverdue).toBe(false);
  });
});

describe('resolveRelevance — per-side fallback chain', () => {
  const userDefaults: RelevanceWindow = {
    before: { type: 'cal', unit: 'week' },
    after: { type: 'dur', minutes: 120 }
  };

  it('item bound wins over user default, per side', () => {
    const r = resolveRelevance(
      infoWith({ rl: { before: { type: 'dur', minutes: 10 } } }),
      resolved,
      userDefaults
    );
    // before: item dur:10. after: falls through to user default dur:120.
    expect(r.beforeStart).toBe(start.getTime() - 10 * MIN);
    expect(r.afterEnd).toBe(end.getTime() + 120 * MIN);
  });

  it('user default fills sides the item leaves unset', () => {
    const r = resolveRelevance(infoWith({}), resolved, userDefaults);
    expect(r.beforeStart).toBe(new Date(2026, 3, 13, 0, 0, 0, 0).getTime()); // week start
    expect(r.afterEnd).toBe(end.getTime() + 120 * MIN);
  });

  it('builtin default (same day / same day) applies when nothing is set', () => {
    expect(BUILTIN_RELEVANCE).toEqual({ before: { type: 'cal', unit: 'day' }, after: { type: 'cal', unit: 'day' } });
    const r = resolveRelevance(infoWith({}), resolved);
    expect(r.beforeStart).toBe(new Date(2026, 3, 15, 0, 0, 0, 0).getTime());
    expect(r.afterEnd).toBe(new Date(2026, 3, 16, 0, 0, 0, 0).getTime() - 1);
  });

  it('cal:day keeps an all-day (half-open) window same-day, not bleeding into the next day', () => {
    // resolveTimeWindow yields a half-open window for date-only items: an item
    // due Apr 15 resolves to start=Apr 15 00:00, end=Apr 16 00:00 (exclusive).
    // The after window must still end on Apr 15, otherwise a previous-day item
    // reads as relevant the following day.
    const allDay = {
      start: new Date(2026, 3, 15, 0, 0, 0, 0),
      end: new Date(2026, 3, 16, 0, 0, 0, 0)
    };
    const r = resolveRelevance(infoWith({}), allDay);
    expect(r.beforeStart).toBe(new Date(2026, 3, 15, 0, 0, 0, 0).getTime());
    expect(r.afterEnd).toBe(new Date(2026, 3, 16, 0, 0, 0, 0).getTime() - 1);
  });

  it('a symmetric dur rl resolves symmetrically', () => {
    const r = resolveRelevance(infoWith({ rl: { before: { type: 'dur', minutes: 60 }, after: { type: 'dur', minutes: 60 } } }), resolved, userDefaults);
    expect(r.beforeStart).toBe(start.getTime() - 60 * MIN);
    expect(r.afterEnd).toBe(end.getTime() + 60 * MIN);
  });
});
