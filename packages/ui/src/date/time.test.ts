import { describe, it, expect } from 'vitest';
import { extract_end_minute_like, extract_start_minute_like, number_from_given_day } from './time.ts';
import { is_leap_year } from './time.ts';
import type { TimeReference } from './types.ts';

describe('number_from_given_day', () => {
  it('should return 0 when target is the same as first day of week', () => {
    expect(number_from_given_day(0, 0)).toBe(0); // Sun to Sun
    expect(number_from_given_day(1, 1)).toBe(0); // Mon to Mon
    expect(number_from_given_day(6, 6)).toBe(0); // Sat to Sat
  });

  it('should return positive offset when target is later in the week', () => {
    expect(number_from_given_day(2, 1)).toBe(1); // Tue (2) from Mon (1)
    expect(number_from_given_day(6, 1)).toBe(5); // Sat (6) from Mon (1)
    expect(number_from_given_day(5, 0)).toBe(5); // Fri (5) from Sun (0)
  });

  it('should wrap around correctly when target is earlier in the numerical week', () => {
    expect(number_from_given_day(0, 1)).toBe(6); // Sun (0) from Mon (1)
    expect(number_from_given_day(1, 2)).toBe(6); // Mon (1) from Tue (2)
    expect(number_from_given_day(5, 6)).toBe(6); // Fri (5) from Sat (6)
    expect(number_from_given_day(0, 6)).toBe(1); // Sun (0) from Sat (6)
  });
});

describe('is_leap_year', () => {
    it('returns false for common non-leap years', () => {
        expect(is_leap_year(2001)).toBe(false);
        expect(is_leap_year(2019)).toBe(false);
        expect(is_leap_year(2023)).toBe(false);
        expect(is_leap_year(1999)).toBe(false);
    });

    it('returns true for standard leap years (divisible by 4, but not 100)', () => {
        expect(is_leap_year(2004)).toBe(true);
        expect(is_leap_year(2020)).toBe(true);
        expect(is_leap_year(2024)).toBe(true);
        expect(is_leap_year(1996)).toBe(true);
    });

    it('returns false for century years not divisible by 400', () => {
        expect(is_leap_year(1900)).toBe(false);
        expect(is_leap_year(2100)).toBe(false);
        expect(is_leap_year(1800)).toBe(false);
        expect(is_leap_year(1700)).toBe(false);
    });

    it('returns true for century years divisible by 400', () => {
        expect(is_leap_year(2000)).toBe(true);
        expect(is_leap_year(1600)).toBe(true);
        expect(is_leap_year(2400)).toBe(true);
    });

    it('handles negative years correctly', () => {
        // Technically standard Gregorian leap year rules extrapolate backwards
        expect(is_leap_year(-4)).toBe(true);
        expect(is_leap_year(-100)).toBe(false);
        expect(is_leap_year(-400)).toBe(true);
    });

    it('handles year zero correctly', () => {
        // 0 is typically considered a leap year in ISO 8601 (proleptic Gregorian calendar)
        expect(is_leap_year(0)).toBe(true);
    });
});

describe('minute-like extraction', () => {
    it('uses vague range edges for start and implicit end', () => {
        const tr: TimeReference = {
            i: { s: { type: 'vg', t: 'mo' } }
        };
        expect(extract_start_minute_like(tr)).toBe(420);
        expect(extract_end_minute_like(tr)).toBe(720);
    });

    it('uses the explicit vague end edge when present', () => {
        const tr: TimeReference = {
            i: {
                s: { type: 'vg', t: 'mo' },
                e: { type: 'vg', t: 'af' }
            }
        };
        expect(extract_end_minute_like(tr)).toBe(1080);
    });
});
