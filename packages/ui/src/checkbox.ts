/**
 * Multi-state checkbox values, aligned with progress check states
 * (`True` / `False` / `Partial` / `NA` / `WontDo`).
 *
 * Binary checkboxes map `checked` → `True`/`False` and `indeterminate` → `Partial`.
 */
export type CheckboxState = 'True' | 'False' | 'Partial' | 'NA' | 'WontDo';

export const CHECKBOX_STATES: readonly CheckboxState[] = [
  'False',
  'Partial',
  'True',
  'NA',
  'WontDo'
] as const;

export const CHECKBOX_STATE_LABELS: Record<CheckboxState, string> = {
  False: 'Not done',
  Partial: 'In progress',
  True: 'Done',
  NA: 'NA',
  WontDo: "Won't do"
};

/** Default click cycle for interactive multi-state checkboxes. */
export const DEFAULT_CHECKBOX_CYCLE: readonly CheckboxState[] = ['False', 'True'] as const;

/** Full progress cycle including partial / terminal states. */
export const FULL_CHECKBOX_CYCLE: readonly CheckboxState[] = [
  'False',
  'Partial',
  'True',
  'NA',
  'WontDo'
] as const;

export function nextCheckboxState(
  current: CheckboxState,
  cycle: readonly CheckboxState[] = DEFAULT_CHECKBOX_CYCLE
): CheckboxState {
  if (cycle.length === 0) return current;
  const idx = cycle.indexOf(current);
  if (idx < 0) {
    // State outside the cycle (e.g. NA while cycling False/True): jump to first.
    return cycle[0]!;
  }
  return cycle[(idx + 1) % cycle.length]!;
}

export function checkboxStateFromBoolean(
  checked: boolean,
  indeterminate = false
): CheckboxState {
  if (indeterminate) return 'Partial';
  return checked ? 'True' : 'False';
}

export function isCheckboxFilled(state: CheckboxState): boolean {
  return state === 'True' || state === 'Partial' || state === 'NA' || state === 'WontDo';
}

export function checkboxAriaChecked(state: CheckboxState): boolean | 'mixed' {
  if (state === 'True') return true;
  if (state === 'Partial') return 'mixed';
  return false;
}
