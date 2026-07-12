import type { AdditionalWithId } from './types.ts';
import type { DateInformation } from '@modular-app/ui/date';

/**
 * Helpers for reading/writing the "date" additional.
 *
 * Wire shape (flat, single source of truth):
 *   `{ id, type: 'date', date_info, source_additional_id? }`
 *
 * The compact `{ t: 'date', d: { date_info } }` form is intentionally not
 * supported by the current runtime.
 */

export function isDateAdditional(additional: AdditionalWithId | Record<string, any>): boolean {
  return (additional as any).type === 'date';
}

/**
 * Returns a plain-object view of the additional's data payload
 * (`{ date_info, source_additional_id? }`), or `null` if no `date_info`
 * can be found.
 */
export function getDateAdditionalData(
  additional: AdditionalWithId | Record<string, any>
): Record<string, any> | null {
  const a = additional as any;
  if (typeof a.date_info === 'object' && a.date_info !== null) {
    const topLevelSourceId =
      typeof a.source_additional_id === 'string'
        ? a.source_additional_id
        : typeof a.date_info?.source_additional_id === 'string'
          ? a.date_info.source_additional_id
          : undefined;

    return {
      ...(topLevelSourceId ? { source_additional_id: topLevelSourceId } : {}),
      date_info: a.date_info
    };
  }
  return null;
}

/** Convenience: returns just the `DateInformation`, or `null`. */
export function getDateAdditionalInfo(
  additional: AdditionalWithId | Record<string, any>
): DateInformation | null {
  const data = getDateAdditionalData(additional);
  const dateInfo = data?.date_info;
  return dateInfo && typeof dateInfo === 'object' ? (dateInfo as DateInformation) : null;
}

/**
 * Merge a `{ date_info, source_additional_id? }` payload back into an additional.
 */
export function patchDateAdditional<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  data: Record<string, any>
): T {
  const topLevel: Record<string, any> = {
    ...additional,
    type: 'date',
    date_info: data.date_info
  };
  // Fresh per-id LWW stamp at queue time: a modified entry that kept its old
  // updated_at would lose fn::merge_additionals to any concurrent write
  // (queueOp only stamps entries lacking updated_at).
  delete topLevel.updated_at;

  if (typeof data.source_additional_id === 'string') {
    topLevel.source_additional_id = data.source_additional_id;
  }

  return topLevel as T;
}

/** Convenience: write a new `DateInformation` into an additional in-place. */
export function patchDateAdditionalInfo<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  nextDateInfo: DateInformation
): T {
  const data = getDateAdditionalData(additional) ?? {};
  return patchDateAdditional(additional, { ...data, date_info: nextDateInfo });
}
