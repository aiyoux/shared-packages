import type { AdditionalWithId, Item } from './types.ts';
import type { DateInformation } from '@modular-app/ui/date';
import { getDateAdditionalData, isDateAdditional, patchDateAdditionalInfo } from './date-additional.ts';

export type DisplayAs = 'mj' | 'mi' | 'sm' | 'n';

export interface DateAdditionalEntry {
  additionalId: string;
  info: DateInformation;
}

export function normalizeDisplayAs(value: unknown): DisplayAs {
  if (value === 'Major' || value === 'mj') return 'mj';
  if (value === 'Minor' || value === 'mi') return 'mi';
  if (value === 'Mini' || value === 'sm') return 'sm';
  return 'n';
}

export function readDateInformation(additional: AdditionalWithId): DateInformation | null {
  if (!isDateAdditional(additional)) return null;
  const data = getDateAdditionalData(additional);
  const info = data?.date_info as DateInformation | undefined;
  return info?.value ? info : null;
}

export function getDateInfo(item: Pick<Item, 'additionals'> | undefined): DateInformation | null {
  if (!item?.additionals) return null;
  for (const additional of item.additionals) {
    const info = readDateInformation(additional);
    if (info) return info;
  }
  return null;
}

export function getPrimaryDateAdditional(
  item: Pick<Item, 'additionals'> | undefined
): DateAdditionalEntry | null {
  if (!item?.additionals) return null;
  for (const additional of item.additionals) {
    const info = readDateInformation(additional);
    if (info) {
      return {
        additionalId: additional.id,
        info
      };
    }
  }
  return null;
}

export function setDateAdditionalValue(
  additionals: AdditionalWithId[],
  additionalId: string,
  nextInfo: DateInformation
): AdditionalWithId[] {
  let mutated = false;
  const out = additionals.map((additional) => {
    if (additional.id !== additionalId) return additional;
    if (!isDateAdditional(additional)) return additional;

    mutated = true;
    return patchDateAdditionalInfo(additional, structuredClone(nextInfo));
  });

  return mutated ? out : additionals;
}

export function isStatus(info: DateInformation): boolean {
  return info.is === true;
}

export function relevanceMinutes(info: DateInformation, userDefault?: number | null): number {
  // Canonical: relevance lives in `rl`; a symmetric dur window maps back to a
  // scalar minutes for legacy callers.
  const before = info.rl?.before;
  const after = info.rl?.after;
  if (before?.type === 'dur' && after?.type === 'dur' && before.minutes === after.minutes) {
    return before.minutes;
  }
  if (typeof userDefault === 'number' && Number.isFinite(userDefault) && userDefault >= 0) {
    return userDefault;
  }
  return 1440;
}

export function isRelevanceInfinite(info: DateInformation): boolean {
  return info.rl?.before?.type === 'inf' && info.rl?.after?.type === 'inf';
}

export function pinWhenOverdue(info: DateInformation): boolean {
  return info.po === true;
}

export function displayAsOf(info: DateInformation): DisplayAs {
  return normalizeDisplayAs(info.ds);
}
