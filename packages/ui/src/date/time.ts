import type { TimeReference } from './types.ts';
import { extractDateWindow } from './time-week.ts';

export const MINUTE_MS = 1000 * 60;
export const HOUR_MS = MINUTE_MS * 60;
export const DAY_MS = HOUR_MS * 24;
export const WEEK_MS = DAY_MS * 7;

export function days_between(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

/**
 * Returns number of days to subtract from target_weekday to reach first_day_of_week
 * e.g. target=Mon, first=Mon -> 0
 * e.g. target=Tue, first=Mon -> 1
 */
export function number_from_given_day(target_weekday: number, first_day_of_week: number): number {
  return (target_weekday - first_day_of_week + 7) % 7;
}

export function days_in_month(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function is_leap_year(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function days_in_year(year: number): number {
  return is_leap_year(year) ? 366 : 365;
}

function get_ba(tr: TimeReference | undefined, field: keyof TimeReference | 'hr' | 'min', key: 's' | 'e'): number | null {
    if (!tr) return null;
    const obj = (tr as any)[field]?.[key];
    return obj?.type === 'ba' ? (obj.v as number) : null;
}

export function extract_start_date(tr: TimeReference): Date | null {
    if (!tr) return null;
    return extractDateWindow(tr)?.start ?? null;
}

export function extract_end_date(tr: TimeReference): Date | null {
    if (!tr) return null;
    return extractDateWindow(tr)?.end ?? null;
}

export function extract_start_minute(tr: TimeReference): number | null {
    if (!tr) return null;
    return get_ba(tr, 'i', 's');
}

export function extract_end_minute(tr: TimeReference): number | null {
    if (!tr) return null;
    return get_ba(tr, 'i', 'e') ?? get_ba(tr, 'i', 's');
}

import { vagueMinuteValue, type VagueMinuteCode } from './vague-time.ts';

/**
 * Like `extract_start_minute` but falls back to the midpoint (base) of a vague
 * minute reference so that vague times can be positioned on a timeline.
 */
export function extract_start_minute_like(tr: TimeReference): number | null {
    if (!tr) return null;
    const obj = tr.i?.s;
    if (!obj) return null;
    if (obj.type === 'ba') return obj.v as number;
    if (obj.type === 'vg') {
        return vagueMinuteValue(obj.t as VagueMinuteCode, 'start');
    }
    return null;
}

/**
 * Like `extract_end_minute` but falls back to the midpoint (base) of a vague
 * minute reference, and ultimately falls back to `extract_start_minute_like`.
 */
export function extract_end_minute_like(tr: TimeReference): number | null {
    if (!tr) return null;
    const obj = tr.i?.e;
    if (!obj) {
        const startObj = tr.i?.s;
        if (startObj?.type === 'vg') {
            return vagueMinuteValue(startObj.t as VagueMinuteCode, 'end');
        }
        return extract_start_minute_like(tr);
    }
    if (obj.type === 'ba') return obj.v as number;
    if (obj.type === 'vg') {
        return vagueMinuteValue(obj.t as VagueMinuteCode, 'end');
    }
    return extract_start_minute_like(tr);
}
