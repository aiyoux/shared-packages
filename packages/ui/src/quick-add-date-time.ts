import type { BaseOrVagueReference, TimeReference, VagueMinuteCode, VagueMonthCode } from './date';
import { cleanupEmptyFields, cloneTimeReference, firstDayOfWeek } from './date';

export type QuickAddDateTimePresetKind =
  | 'today-morning'
  | 'today-afternoon'
  | 'tomorrow-morning'
  | 'tomorrow-afternoon'
  | 'this-evening'
  | 'weekend'
  | 'next-week'
  | 'this-quarter'
  | 'first-half'
  | 'second-half';

export interface QuickAddDateTimePreset {
  id: QuickAddDateTimePresetKind | string;
  label: string;
  hint: string;
  build: (context: QuickAddDateTimePresetContext) => TimeReference;
}

export interface QuickAddDateTimePresetContext {
  now: Date;
  firstDayOfWeek?: number;
}

export function cloneQuickAddTimeReference(value: TimeReference | undefined): TimeReference {
  return cloneTimeReference(value);
}

export function baseRef(value: number): BaseOrVagueReference<string, number> {
  return { type: 'ba', v: value };
}

export function vagueRef(code: string): BaseOrVagueReference<string, number> {
  return { type: 'vg', t: code };
}

export function exactDateTimeReference(
  date: Date,
  minute?: BaseOrVagueReference<string, number>
): TimeReference {
  const next: TimeReference = {
    y: { s: baseRef(date.getFullYear()) },
    m: { s: baseRef(date.getMonth() + 1) },
    d: { s: baseRef(date.getDate()) }
  };

  if (minute) {
    next.i = { s: minute };
  }

  return cleanupEmptyFields(next);
}

export function dateRangeReference(start: Date, end: Date): TimeReference {
  return cleanupEmptyFields({
    y: { s: baseRef(start.getFullYear()), e: baseRef(end.getFullYear()) },
    m: { s: baseRef(start.getMonth() + 1), e: baseRef(end.getMonth() + 1) },
    d: { s: baseRef(start.getDate()), e: baseRef(end.getDate()) }
  });
}

export function vagueMonthReference(year: number, monthCode: VagueMonthCode): TimeReference {
  return cleanupEmptyFields({
    y: { s: baseRef(year) },
    m: { s: vagueRef(monthCode) }
  });
}

export function rowWeekReference(date: Date, firstDay = 1): TimeReference {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const firstRowStart = firstDayOfWeek(new Date(year, month - 1, 1), firstDay);
  const selectedRowStart = firstDayOfWeek(date, firstDay);
  const week = Math.floor((selectedRowStart.getTime() - firstRowStart.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return cleanupEmptyFields({
    y: { s: baseRef(year) },
    m: { s: baseRef(month) },
    w: { s: baseRef(Math.max(1, week)) },
    wm: 'row',
    ws: firstDay
  });
}

export function sameOrNextWeekday(now: Date, targetDay: number): Date {
  const date = new Date(now);
  const offset = (targetDay - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + offset);
  return date;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

export function quarterForMonth(month: number): VagueMonthCode {
  if (month <= 3) return 'q1';
  if (month <= 6) return 'q2';
  if (month <= 9) return 'q3';
  return 'q4';
}

export function buildQuickAddDateTimePreset(
  kind: QuickAddDateTimePresetKind,
  context: QuickAddDateTimePresetContext
): TimeReference {
  const { now } = context;

  if (kind === 'today-morning') return exactDateTimeReference(now, vagueRef('mo' satisfies VagueMinuteCode));
  if (kind === 'today-afternoon') return exactDateTimeReference(now, vagueRef('af' satisfies VagueMinuteCode));
  if (kind === 'tomorrow-morning') return exactDateTimeReference(addDays(now, 1), vagueRef('mo' satisfies VagueMinuteCode));
  if (kind === 'tomorrow-afternoon') return exactDateTimeReference(addDays(now, 1), vagueRef('af' satisfies VagueMinuteCode));
  if (kind === 'this-evening') return exactDateTimeReference(now, vagueRef('ev' satisfies VagueMinuteCode));

  if (kind === 'weekend') {
    const saturday = sameOrNextWeekday(now, 6);
    return dateRangeReference(saturday, addDays(saturday, 1));
  }

  if (kind === 'next-week') {
    const firstDay = context.firstDayOfWeek ?? 1;
    const nextStart = addDays(sameOrNextWeekday(now, firstDay), now.getDay() === firstDay ? 7 : 0);
    return rowWeekReference(nextStart, firstDay);
  }

  if (kind === 'this-quarter') {
    return vagueMonthReference(now.getFullYear(), quarterForMonth(now.getMonth() + 1));
  }

  if (kind === 'first-half') {
    return vagueMonthReference(now.getFullYear(), 'fh');
  }

  return vagueMonthReference(now.getFullYear(), 'sh');
}

export const DEFAULT_QUICK_ADD_DATE_TIME_PRESETS: QuickAddDateTimePreset[] = [
  {
    id: 'today-morning',
    label: 'Today',
    hint: 'Morning',
    build: (context) => buildQuickAddDateTimePreset('today-morning', context)
  },
  {
    id: 'tomorrow-afternoon',
    label: 'Tomorrow',
    hint: 'Afternoon',
    build: (context) => buildQuickAddDateTimePreset('tomorrow-afternoon', context)
  },
  {
    id: 'this-evening',
    label: 'This evening',
    hint: 'Vague time',
    build: (context) => buildQuickAddDateTimePreset('this-evening', context)
  },
  {
    id: 'weekend',
    label: 'Weekend',
    hint: 'Two-day range',
    build: (context) => buildQuickAddDateTimePreset('weekend', context)
  },
  {
    id: 'next-week',
    label: 'Next week',
    hint: 'Week',
    build: (context) => buildQuickAddDateTimePreset('next-week', context)
  },
  {
    id: 'this-quarter',
    label: 'This quarter',
    hint: 'Vague month',
    build: (context) => buildQuickAddDateTimePreset('this-quarter', context)
  },
  {
    id: 'first-half',
    label: 'First half',
    hint: 'Vague month',
    build: (context) => buildQuickAddDateTimePreset('first-half', context)
  },
  {
    id: 'second-half',
    label: 'Second half',
    hint: 'Vague month',
    build: (context) => buildQuickAddDateTimePreset('second-half', context)
  }
];
