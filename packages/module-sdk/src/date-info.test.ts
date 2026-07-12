import { describe, expect, it } from 'vitest';
import type { AdditionalWithId, Item } from './types.ts';
import type { DateInformation } from '@modular-app/ui/date';
import {
  displayAsOf,
  getDateInfo,
  getPrimaryDateAdditional,
  isRelevanceInfinite,
  isStatus,
  normalizeDisplayAs,
  pinWhenOverdue,
  relevanceMinutes,
  setDateAdditionalValue
} from './date-info.ts';

const info: DateInformation = {
  is: false,
  value: { y: { s: { type: 'ba', v: 2026 } } }
};

describe('date-info helpers', () => {
  it('reads the first valid date additional', () => {
    const item: Item = {
      id: 'records:1',
      text: 'Item',
      additionals: [
        { id: 'pg1', type: 'pg', prog_type: { ch: 'f' } } as AdditionalWithId,
        { id: 'd1', type: 'date', date_info: info } as AdditionalWithId
      ]
    };

    expect(getDateInfo(item)).toBe(info);
    expect(getPrimaryDateAdditional(item)).toEqual({ additionalId: 'd1', info });
  });

  it('returns null when no date_info value is present', () => {
    expect(getDateInfo({ id: 'records:1', text: 'No date', additionals: [{ id: 'bad', type: 'date' } as any] })).toBeNull();
  });

  it('updates a date additional immutably and preserves unrelated additionals', () => {
    const next: DateInformation = {
      is_status: true,
      value: { d: { s: { type: 'ba', v: 1 } } }
    };
    const additionals: AdditionalWithId[] = [
      { id: 'd1', type: 'date', date_info: info } as AdditionalWithId,
      { id: 'pg1', type: 'pg', prog_type: { ch: 'f' } } as AdditionalWithId
    ];

    const result = setDateAdditionalValue(additionals, 'd1', next);

    expect(result).not.toBe(additionals);
    expect((result[0] as any).date_info).toEqual(next);
    expect(result[1]).toBe(additionals[1]);
  });

  it('normalizes display and status from canonical short fields', () => {
    expect(normalizeDisplayAs('Major')).toBe('mj');
    expect(normalizeDisplayAs('sm')).toBe('sm');
    expect(displayAsOf({ ...info, ds: 'sm' })).toBe('sm');
    expect(isStatus({ ...info, is: true })).toBe(true);
  });

  it('reads relevance flags from the canonical rl window', () => {
    expect(relevanceMinutes({ ...info, rl: { before: { type: 'dur', minutes: 30 }, after: { type: 'dur', minutes: 30 } } })).toBe(30);
    expect(relevanceMinutes(info, 45)).toBe(45);
    expect(relevanceMinutes(info)).toBe(1440);
    expect(isRelevanceInfinite({ ...info, rl: { before: { type: 'inf' }, after: { type: 'inf' } } })).toBe(true);
    expect(pinWhenOverdue({ ...info, po: true })).toBe(true);
  });
});
