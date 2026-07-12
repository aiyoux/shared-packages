import type { BaseOrVagueReference, TimeReference, WeekModeCode } from './types.ts';
import {
  VAGUE_MONTHS,
  type VagueMonthCode,
  vagueMonthValue
} from './vague-time.ts';

export type DateSide = 'start' | 'end';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function firstDayOfWeek(date: Date, weekStart: number): Date {
  const normalized = ((weekStart % 7) + 7) % 7;
  const daysBack = (date.getDay() - normalized + 7) % 7;
  return addDays(startOfDay(date), -daysBack);
}

export function dateFromDayOfYear(year: number, day: number): Date {
  return addDays(new Date(year, 0, 1), clamp(Math.trunc(day), 1, daysInYear(year)) - 1);
}

export function isoWeekStart(weekYear: number, week: number): Date {
  const jan4 = new Date(weekYear, 0, 4);
  const weekOne = firstDayOfWeek(jan4, 1);
  return addDays(weekOne, (Math.trunc(week) - 1) * 7);
}

export function isoWeekCount(weekYear: number): number {
  const dec28 = new Date(weekYear, 11, 28);
  const weekOne = isoWeekStart(weekYear, 1);
  return Math.floor((firstDayOfWeek(dec28, 1).getTime() - weekOne.getTime()) / DAY_MS) / 7 + 1;
}

function ordinalWeekRange(year: number, month: number | null, week: number): { start: Date; end: Date } {
  const safeWeek = Math.max(1, Math.trunc(week));
  if (month !== null) {
    const start = addDays(new Date(year, month - 1, 1), (safeWeek - 1) * 7);
    const end = new Date(year, month - 1, daysInMonth(year, month));
    return { start, end: start > end ? end : new Date(Math.min(addDays(start, 6).getTime(), end.getTime())) };
  }

  const start = addDays(new Date(year, 0, 1), (safeWeek - 1) * 7);
  const end = new Date(year, 11, 31);
  return { start, end: start > end ? end : new Date(Math.min(addDays(start, 6).getTime(), end.getTime())) };
}

function rowWeekRange(year: number, month: number | null, week: number, weekStart: number): { start: Date; end: Date } {
  const anchor = month !== null ? new Date(year, month - 1, 1) : new Date(year, 0, 1);
  const start = addDays(firstDayOfWeek(anchor, weekStart), (Math.max(1, Math.trunc(week)) - 1) * 7);
  return { start, end: addDays(start, 6) };
}

export function weekModeFor(value: TimeReference | undefined): WeekModeCode {
  return value?.wm ?? 'ord';
}

export function weekStartFor(value: TimeReference | undefined): number {
  return typeof value?.ws === 'number' && Number.isFinite(value.ws) ? clamp(Math.trunc(value.ws), 0, 6) : 1;
}

export function weekCountFor(year: number, month: number | null, mode: WeekModeCode, weekStart = 1): number {
  if (mode === 'ord') {
    return Math.ceil((month !== null ? daysInMonth(year, month) : daysInYear(year)) / 7);
  }
  if (mode === 'iso' && month === null) {
    return isoWeekCount(year);
  }

  const first = month !== null ? new Date(year, month - 1, 1) : new Date(year, 0, 1);
  const last = month !== null ? new Date(year, month - 1, daysInMonth(year, month)) : new Date(year, 11, 31);
  const rowStart = firstDayOfWeek(first, mode === 'iso' ? 1 : weekStart);
  const rowEnd = firstDayOfWeek(last, mode === 'iso' ? 1 : weekStart);
  return Math.floor((rowEnd.getTime() - rowStart.getTime()) / DAY_MS / 7) + 1;
}

export function weekRangeFor(
  year: number,
  month: number | null,
  week: number,
  mode: WeekModeCode,
  weekStart = 1
): { start: Date; end: Date } {
  if (mode === 'iso' && month === null) {
    const safeWeek = clamp(Math.trunc(week), 1, isoWeekCount(year));
    const start = isoWeekStart(year, safeWeek);
    return { start, end: addDays(start, 6) };
  }
  if (mode === 'row' || mode === 'iso') {
    return rowWeekRange(year, month, week, mode === 'iso' ? 1 : weekStart);
  }
  return ordinalWeekRange(year, month, week);
}

export function resolvedWeekRangeForRef(
  year: number,
  month: number | null,
  ref: BaseOrVagueReference<string, number>,
  mode: WeekModeCode,
  weekStart: number,
  side: DateSide
): { start: Date; end: Date } {
  const count = weekCountFor(year, month, mode, weekStart);
  const week = ref.type === 'ba' ? ref.v : 1;
  return weekRangeFor(year, month, clamp(week, 1, count), mode, weekStart);
}

function sideRef(value: TimeReference, field: keyof TimeReference, side: 's' | 'e') {
  const fieldValue = value[field] as any;
  return fieldValue?.[side] ?? (side === 'e' ? fieldValue?.s : undefined);
}

function baseValue(ref: any): number | null {
  return ref?.type === 'ba' ? Number(ref.v) : null;
}

function monthValue(ref: any, side: DateSide): number | null {
  if (!ref) return null;
  if (ref.type === 'ba') return Number(ref.v);
  if (ref.type === 'vg') return vagueMonthValue(ref.t as VagueMonthCode, side);
  return null;
}

export function extractDateSide(value: TimeReference, side: DateSide): Date | null {
  const key = side === 'start' ? 's' : 'e';
  const yRef = sideRef(value, 'y', key);
  const mRef = sideRef(value, 'm', key);
  const wRef = sideRef(value, 'w', key);
  const dRef = sideRef(value, 'd', key);
  const year = baseValue(yRef);
  if (year === null) return null;

  const month = monthValue(mRef, side);
  if (wRef?.type === 'ba') {
    const range = resolvedWeekRangeForRef(year, month, wRef, weekModeFor(value), weekStartFor(value), side);
    if (dRef?.type === 'ba') {
      return addDays(range.start, clamp(Number(dRef.v), 1, 7) - 1);
    }
    return side === 'start' ? range.start : range.end;
  }

  if (dRef?.type === 'ba') {
    if (month !== null) return new Date(year, month - 1, clamp(Number(dRef.v), 1, daysInMonth(year, month)));
    return dateFromDayOfYear(year, Number(dRef.v));
  }

  if (month !== null) {
    if (mRef?.type === 'vg') {
      const info = VAGUE_MONTHS[mRef.t as VagueMonthCode];
      const endYear = info?.wraps && side === 'end' ? year + 1 : year;
      const endMonth = month;
      return side === 'start'
        ? new Date(year, month - 1, 1)
        : new Date(endYear, endMonth - 1, daysInMonth(endYear, endMonth));
    }
    return side === 'start'
      ? new Date(year, month - 1, 1)
      : new Date(year, month - 1, daysInMonth(year, month));
  }

  return side === 'start' ? new Date(year, 0, 1) : new Date(year, 11, 31);
}

export function extractDateWindow(value: TimeReference): { start: Date; end: Date } | null {
  const start = extractDateSide(value, 'start');
  if (!start) return null;
  return { start, end: extractDateSide(value, 'end') ?? start };
}
