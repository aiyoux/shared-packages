import { describe, it, expect } from 'vitest';
import type { TimeReference } from './types.ts';
import { explicitTimeReference, materializeTimeReference, resolveStart, resolveEnd, resolveTimeWindow, hasAnyDateField } from './time-reference.ts';
import {
  currentVagueMinute,
  vagueMinuteForMinuteOfDay,
  VAGUE_MINUTES
} from './vague-time.ts';

const NOW = new Date(2026, 3, 14, 10, 30, 0, 0); // Tue Apr 14 2026 10:30 local

describe('vague-time lookup', () => {
  it('maps concrete minute-of-day to a bucket', () => {
    expect(vagueMinuteForMinuteOfDay(9 * 60)).toBe('mo');
    expect(vagueMinuteForMinuteOfDay(15 * 60)).toBe('af');
    expect(vagueMinuteForMinuteOfDay(20 * 60)).toBe('ev');
    expect(vagueMinuteForMinuteOfDay(23 * 60)).toBe('ni');
  });

  it('returns null for out-of-range input', () => {
    expect(vagueMinuteForMinuteOfDay(-1)).toBeNull();
    expect(vagueMinuteForMinuteOfDay(1500)).toBeNull();
  });

  it('currentVagueMinute reads local time from a Date', () => {
    const morning = new Date(2026, 3, 14, 9, 0);
    expect(currentVagueMinute(morning)).toBe('mo');
    const evening = new Date(2026, 3, 14, 20, 0);
    expect(currentVagueMinute(evening)).toBe('ev');
  });

  it('Morning range is 7am–12pm inclusive', () => {
    expect(VAGUE_MINUTES.mo.range).toEqual([420, 720]);
  });
});

describe('resolveStart / resolveEnd — base references', () => {
  it('resolves a concrete year/month/day/minute', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 4 } },
      d: { s: { type: 'ba', v: 20 } },
      i: { s: { type: 'ba', v: 9 * 60 + 15 } }
    };
    const r = resolveStart(tr, NOW);
    expect(r.getFullYear()).toBe(2026);
    expect(r.getMonth()).toBe(3); // April → 0-indexed 3
    expect(r.getDate()).toBe(20);
    expect(r.getHours()).toBe(9);
    expect(r.getMinutes()).toBe(15);
  });

  it('end side falls back to start when not explicitly set', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 4 } },
      d: { s: { type: 'ba', v: 20 } },
      i: { s: { type: 'ba', v: 540 } }
    };
    const e = resolveEnd(tr, NOW);
    expect(e.getFullYear()).toBe(2026);
    expect(e.getMonth()).toBe(3);
    expect(e.getDate()).toBe(20);
    expect(e.getHours()).toBe(9);
  });

  it('date-only reference (no minute) resolves to midnight', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 4 } },
      d: { s: { type: 'ba', v: 20 } }
    };
    const r = resolveStart(tr, NOW);
    expect(r.getHours()).toBe(0);
    expect(r.getMinutes()).toBe(0);
  });
});

describe('resolveStart / resolveEnd — vague references (range edges)', () => {
  it('Morning resolves start → 07:00, end → 12:00', () => {
    const tr: TimeReference = {
      i: { s: { type: 'vg', t: 'mo' } }
    };
    const s = resolveStart(tr, NOW);
    const e = resolveEnd(tr, NOW);
    expect(s.getHours()).toBe(7);
    expect(s.getMinutes()).toBe(0);
    expect(e.getHours()).toBe(12);
    expect(e.getMinutes()).toBe(0);
  });

  it('Afternoon resolves start → 12:00, end → 18:00', () => {
    const tr: TimeReference = {
      i: { s: { type: 'vg', t: 'af' } }
    };
    expect(resolveStart(tr, NOW).getHours()).toBe(12);
    expect(resolveEnd(tr, NOW).getHours()).toBe(18);
  });

  it('vague + concrete day resolves both fields', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 4 } },
      d: { s: { type: 'ba', v: 20 } },
      i: { s: { type: 'vg', t: 'ev' } }
    };
    const s = resolveStart(tr, NOW);
    expect(s.getDate()).toBe(20);
    expect(s.getHours()).toBe(18); // Evening low edge
    const e = resolveEnd(tr, NOW);
    expect(e.getHours()).toBe(22); // Evening high edge
  });

  it('date side stays on today when only a vague minute is set', () => {
    // Vague-only items float to today — they describe "the morning" generically
    const tr: TimeReference = {
      i: { s: { type: 'vg', t: 'mo' } }
    };
    const s = resolveStart(tr, NOW);
    expect(s.getFullYear()).toBe(NOW.getFullYear());
    expect(s.getMonth()).toBe(NOW.getMonth());
    expect(s.getDate()).toBe(NOW.getDate());
  });
});

describe('resolveStart / resolveEnd — offset references', () => {
  it('day offset from Now', () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 2, a: 'nw' } }
    };
    const r = resolveStart(tr, NOW);
    expect(r.getDate()).toBe(16); // 14 + 2
  });

  it('day offset from UserProvided', () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 1, a: 'up' } }
    };
    const up = new Date(2026, 5, 10);
    const r = resolveStart(tr, NOW, { userProvided: up });
    expect(r.getMonth()).toBe(5);
    expect(r.getDate()).toBe(11);
  });

  it('minute offset from ParentResolved', () => {
    const tr: TimeReference = {
      i: { s: { type: 'of', v: 30, a: 'pr' } }
    };
    const parent = new Date(2026, 3, 14, 9, 0);
    const r = resolveStart(tr, NOW, { parentResolved: parent });
    expect(r.getHours()).toBe(9);
    expect(r.getMinutes()).toBe(30);
  });

  it('ParentResolved falls through to UserProvided then Now', () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 3, a: 'pr' } }
    };
    const up = new Date(2026, 3, 1);
    const r = resolveStart(tr, NOW, { userProvided: up });
    expect(r.getMonth()).toBe(3);
    expect(r.getDate()).toBe(4); // 1 + 3
  });

  it('inherits parent minute-of-day for parent-relative date offsets with no explicit minute', () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 0, a: 'pr' } }
    };
    const parent = new Date(2026, 3, 14, 12, 0);
    const r = resolveStart(tr, NOW, { parentResolved: parent });
    expect(r.getHours()).toBe(12);
    expect(r.getMinutes()).toBe(0);
  });

  it('preserves inherited parent minute-of-day across parent-relative day shifts', () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 1, a: 'pr' } }
    };
    const parent = new Date(2026, 3, 14, 12, 0);
    const r = resolveStart(tr, NOW, { parentResolved: parent });
    expect(r.getDate()).toBe(15);
    expect(r.getHours()).toBe(12);
    expect(r.getMinutes()).toBe(0);
  });
});

describe('resolveStart / resolveEnd — vague day', () => {
  it('EarlyMonth resolves start → day 1, end → day 10', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 4 } },
      d: { s: { type: 'vg', t: 'em' } }
    };
    expect(resolveStart(tr, NOW).getDate()).toBe(1);
    expect(resolveEnd(tr, NOW).getDate()).toBe(10);
  });

  it('LateMonth resolves start → day 20, end → day 31', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 1 } },
      d: { s: { type: 'vg', t: 'lm' } }
    };
    expect(resolveStart(tr, NOW).getDate()).toBe(20);
    expect(resolveEnd(tr, NOW).getDate()).toBe(31);
  });

  it('FirstHalf / SecondHalf cover whole month (31-day month)', () => {
    const fh: TimeReference = {
      m: { s: { type: 'ba', v: 7 } }, // July
      d: { s: { type: 'vg', t: 'fh' } }
    };
    expect(resolveStart(fh, NOW).getDate()).toBe(1);
    expect(resolveEnd(fh, NOW).getDate()).toBe(15);

    const sh: TimeReference = {
      m: { s: { type: 'ba', v: 7 } },
      d: { s: { type: 'vg', t: 'sh' } }
    };
    expect(resolveStart(sh, NOW).getDate()).toBe(16);
    expect(resolveEnd(sh, NOW).getDate()).toBe(31);
  });

  it('SecondHalf clamps to month max in short months', () => {
    // June only has 30 days; vg-day end 31 must clamp to 30
    const tr: TimeReference = {
      m: { s: { type: 'ba', v: 6 } }, // June
      d: { s: { type: 'vg', t: 'sh' } }
    };
    expect(resolveEnd(tr, NOW).getDate()).toBe(30);
  });

  it('SecondHalf clamps to 28/29 in February', () => {
    const nonLeap: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 2 } },
      d: { s: { type: 'vg', t: 'sh' } }
    };
    expect(resolveEnd(nonLeap, NOW).getDate()).toBe(28);

    const leap: TimeReference = {
      y: { s: { type: 'ba', v: 2028 } },
      m: { s: { type: 'ba', v: 2 } },
      d: { s: { type: 'vg', t: 'sh' } }
    };
    expect(resolveEnd(leap, NOW).getDate()).toBe(29);
  });
});

describe('resolveStart / resolveEnd — vague month', () => {
  it('Q2 resolves start → April, end → June', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'vg', t: 'q2' } }
    };
    expect(resolveStart(tr, NOW).getMonth()).toBe(3);  // April
    expect(resolveEnd(tr, NOW).getMonth()).toBe(5);    // June
  });

  it('Summer resolves start → June, end → August', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'vg', t: 'su' } }
    };
    expect(resolveStart(tr, NOW).getMonth()).toBe(5);
    expect(resolveEnd(tr, NOW).getMonth()).toBe(7);
  });

  it('Winter wraps the year: start → Dec Y, end → Feb Y+1', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'vg', t: 'wi' } }
    };
    const s = resolveStart(tr, NOW);
    expect(s.getFullYear()).toBe(2026);
    expect(s.getMonth()).toBe(11); // December

    const e = resolveEnd(tr, NOW);
    expect(e.getFullYear()).toBe(2027);
    expect(e.getMonth()).toBe(1);  // February
  });

  it('Winter end side still wraps when end field falls back to start', () => {
    // Only `s` is set; end should pick it up via pickSide fallback and
    // still apply the wrap.
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2030 } },
      m: { s: { type: 'vg', t: 'wi' } }
    };
    const e = resolveEnd(tr, NOW);
    expect(e.getFullYear()).toBe(2031);
    expect(e.getMonth()).toBe(1);
  });

  it('Non-wrapping months leave the year untouched', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'vg', t: 'q4' } }
    };
    expect(resolveStart(tr, NOW).getFullYear()).toBe(2026);
    expect(resolveEnd(tr, NOW).getFullYear()).toBe(2026);
  });
});

describe('resolveStart / resolveEnd — week references', () => {
  it('ordinal year weeks are parent-bounded seven-day blocks', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      w: { s: { type: 'ba', v: 1 } },
      wm: 'ord'
    };
    expect(resolveStart(tr, NOW)).toEqual(new Date(2026, 0, 1));
    expect(resolveEnd(tr, NOW)).toEqual(new Date(2026, 0, 7));
  });

  it('ordinal month weeks are bounded by the month', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 5 } },
      w: { s: { type: 'ba', v: 1 } },
      wm: 'ord'
    };
    expect(resolveStart(tr, NOW)).toEqual(new Date(2026, 4, 1));
    expect(resolveEnd(tr, NOW)).toEqual(new Date(2026, 4, 7));
  });

  it('ISO year weeks use ISO week-year boundaries', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      w: { s: { type: 'ba', v: 1 } },
      wm: 'iso'
    };
    expect(resolveStart(tr, NOW)).toEqual(new Date(2025, 11, 29));
    expect(resolveEnd(tr, NOW)).toEqual(new Date(2026, 0, 4));
  });

  it('ISO month weeks use Monday-start calendar rows', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 5 } },
      w: { s: { type: 'ba', v: 1 } },
      wm: 'iso'
    };
    expect(resolveStart(tr, NOW)).toEqual(new Date(2026, 3, 27));
    expect(resolveEnd(tr, NOW)).toEqual(new Date(2026, 4, 3));
  });

  it('row month weeks respect stored week start', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 5 } },
      w: { s: { type: 'ba', v: 1 } },
      wm: 'row',
      ws: 0
    };
    expect(resolveStart(tr, NOW)).toEqual(new Date(2026, 3, 26));
    expect(resolveEnd(tr, NOW)).toEqual(new Date(2026, 4, 2));
  });

  it('day stacks inside a selected week', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      w: { s: { type: 'ba', v: 2 } },
      d: { s: { type: 'ba', v: 3 } },
      wm: 'ord'
    };
    expect(resolveStart(tr, NOW)).toEqual(new Date(2026, 0, 10));
  });

  it('day without month or week is day-of-year', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      d: { s: { type: 'ba', v: 32 } }
    };
    expect(resolveStart(tr, NOW)).toEqual(new Date(2026, 1, 1));
  });

  it('runtime vague week refs are ignored by week resolution', () => {
    const tr: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 5 } },
      w: { s: { type: 'vg', t: 'lw' } },
      wm: 'ord'
    };
    const withoutWeek: TimeReference = {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 5 } },
      wm: 'ord'
    };
    expect(resolveStart(tr, NOW)).toEqual(resolveStart(withoutWeek, NOW));
    expect(resolveEnd(tr, NOW)).toEqual(resolveEnd(withoutWeek, NOW));
  });
});

describe('resolveStart / resolveEnd — anchor fallback chain', () => {
  it("'pr' anchor: parentResolved wins over userProvided", () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 5, a: 'pr' } }
    };
    const parent = new Date(2026, 5, 1);  // June 1
    const up = new Date(2026, 11, 1);     // December 1
    const r = resolveStart(tr, NOW, { parentResolved: parent, userProvided: up });
    expect(r.getMonth()).toBe(5);
    expect(r.getDate()).toBe(6);
  });

  it("'pr' anchor: falls through to userProvided when parent missing", () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 2, a: 'pr' } }
    };
    const up = new Date(2026, 7, 10);
    const r = resolveStart(tr, NOW, { userProvided: up });
    expect(r.getMonth()).toBe(7);
    expect(r.getDate()).toBe(12);
  });

  it("'pr' anchor: falls all the way to now when both missing", () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 1, a: 'pr' } }
    };
    const r = resolveStart(tr, NOW);
    expect(r.getMonth()).toBe(NOW.getMonth());
    expect(r.getDate()).toBe(NOW.getDate() + 1);
  });

  it("'up' anchor: ignores parentResolved", () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 7, a: 'up' } }
    };
    const parent = new Date(2026, 0, 1);
    const up = new Date(2026, 6, 1);
    const r = resolveStart(tr, NOW, { parentResolved: parent, userProvided: up });
    expect(r.getMonth()).toBe(6);
    expect(r.getDate()).toBe(8);
  });

  it("'up' anchor: falls through to now when userProvided missing", () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 3, a: 'up' } }
    };
    const r = resolveStart(tr, NOW);
    expect(r.getDate()).toBe(NOW.getDate() + 3);
  });

  it("'nw' anchor: always uses now, even when context given", () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 5, a: 'nw' } }
    };
    const parent = new Date(2020, 0, 1);
    const up = new Date(2030, 11, 31);
    const r = resolveStart(tr, NOW, { parentResolved: parent, userProvided: up });
    expect(r.getFullYear()).toBe(NOW.getFullYear());
    expect(r.getMonth()).toBe(NOW.getMonth());
    expect(r.getDate()).toBe(NOW.getDate() + 5);
  });

  it('month-offset rolls year on overflow', () => {
    const tr: TimeReference = {
      m: { s: { type: 'of', v: 14, a: 'nw' } }
    };
    const r = resolveStart(tr, NOW);
    // NOW is April 2026 → +14 months = June 2027
    expect(r.getFullYear()).toBe(2027);
    expect(r.getMonth()).toBe(5);
  });

  it('minute-offset accumulates into hours/days', () => {
    const tr: TimeReference = {
      i: { s: { type: 'of', v: 90, a: 'up' } }
    };
    const up = new Date(2026, 3, 14, 10, 45);
    const r = resolveStart(tr, NOW, { userProvided: up });
    expect(r.getHours()).toBe(12);
    expect(r.getMinutes()).toBe(15);
  });
});

describe('hasAnyDateField', () => {
  it('true when any field set', () => {
    expect(hasAnyDateField({ y: { s: { type: 'ba', v: 2026 } } })).toBe(true);
    expect(hasAnyDateField({ i: { s: { type: 'vg', t: 'mo' } } })).toBe(true);
  });

  it('false for empty or undefined', () => {
    expect(hasAnyDateField(undefined)).toBe(false);
    expect(hasAnyDateField({})).toBe(false);
    expect(hasAnyDateField({ y: {} })).toBe(false);
  });
});

describe('materializeTimeReference', () => {
  it('does not add an explicit end when building a single exact time', () => {
    const start = new Date(2026, 3, 14, 9, 30);
    const tr = explicitTimeReference(start);

    expect(tr.i?.s).toEqual({ type: 'ba', v: 570 });
    expect(tr.i?.e).toBeUndefined();
    expect(tr.d?.e).toBeUndefined();
  });

  it('preserves vague minute labels instead of flattening them to concrete minutes', () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 0, a: 'up' } },
      i: { s: { type: 'vg', t: 'no' } }
    };

    const materialized = materializeTimeReference(tr, NOW, {
      userProvided: new Date(2026, 3, 21, 0, 0)
    });

    expect(materialized.i?.s).toEqual({ type: 'vg', t: 'no' });
    expect(materialized.i?.e).toBeUndefined();
    expect(materialized.d?.e).toBeUndefined();
    expect(materialized.d?.s).toMatchObject({ type: 'ba', v: 21 });
  });

  it('inherits a parent vague minute for parent-relative dates with no explicit minute', () => {
    const tr: TimeReference = {
      d: { s: { type: 'of', v: 0, a: 'pr' } }
    };

    const materialized = materializeTimeReference(tr, NOW, {
      parentResolved: new Date(2026, 3, 14, 12, 0)
    }, {
      inheritedParentMinuteRange: { s: { type: 'vg', t: 'no' } }
    });

    expect(materialized.i?.s).toEqual({ type: 'vg', t: 'no' });
    expect(materialized.i?.e).toBeUndefined();
  });

	  it('does not invent a minute field for plan-start-relative all-day dates', () => {
	    const tr: TimeReference = {
	      d: { s: { type: 'of', v: 0, a: 'up' } }
	    };

    const materialized = materializeTimeReference(tr, NOW, {
      userProvided: new Date(2026, 3, 21, 9, 45)
    });

	    expect(materialized.i).toBeUndefined();
	  });

	  it('resolves plan-start-relative dates without a minute as whole-day windows', () => {
	    const tr: TimeReference = {
	      d: { s: { type: 'of', v: 0, a: 'up' } }
	    };

	    const window = resolveTimeWindow(tr, NOW, {
	      userProvided: new Date(2026, 3, 21, 9, 45)
	    });

	    expect(window.kind).toBe('day');
	    expect(window.hasExplicitMinute).toBe(false);
	    expect(window.start).toEqual(new Date(2026, 3, 21, 0, 0, 0, 0));
	    expect(window.end).toEqual(new Date(2026, 3, 22, 0, 0, 0, 0));
	  });

	  it('resolves explicit minute dates as timed windows', () => {
	    const tr: TimeReference = {
	      d: { s: { type: 'of', v: 0, a: 'up' } },
	      i: { s: { type: 'ba', v: 9 * 60 }, e: { type: 'ba', v: 10 * 60 } }
	    };

	    const window = resolveTimeWindow(tr, NOW, {
	      userProvided: new Date(2026, 3, 21, 0, 0)
	    });

	    expect(window.kind).toBe('timed-window');
	    expect(window.hasExplicitMinute).toBe(true);
	    expect(window.start).toEqual(new Date(2026, 3, 21, 9, 0, 0, 0));
	    expect(window.end).toEqual(new Date(2026, 3, 21, 10, 0, 0, 0));
	  });
	});
