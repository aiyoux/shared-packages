import type {
  BaseOrVagueReference,
  DateInformation,
  ResolveContext,
  StartOrEnd,
  TimeReference,
  VagueDayCode,
  VagueMinuteCode,
  VagueMonthCode,
  VagueYearCode
} from './date';
import { cloneTimeReference, hasAnyDateField, resolveEnd, resolveStart, days_between, explicitTimeReference } from './date';
import type { DatePickerValue } from './date-picker.ts';

export type AnchorType = 'nw' | 'up' | 'pr';
export type ParentOffsetUnit = 'minute' | 'hour' | 'day' | 'month' | 'year';

// Canonical SHORT form only (is / ds / rl / po) — see DateInformation in
// module-sdk types.ts. The editor reads canonical short input and emits short.
function blankDateInformation(): DateInformation {
  return {
    value: {},
    is: false
  };
}

function cloneDateInformation(initial: DateInformation | null | undefined): DateInformation {
  if (!initial) {
    return blankDateInformation();
  }

  return {
    value: cloneTimeReference(initial.value),
    is: Boolean(initial.is),
    ...(initial.offset_enabled ? { offset_enabled: true } : {}),
    ...(initial.ds ? { ds: initial.ds } : {}),
    ...(initial.po ? { po: true } : {}),
    ...(initial.rl ? { rl: structuredClone(initial.rl) } : {})
  };
}

function cloneBaseOrVagueReference<VRT extends string, T>(
  value: BaseOrVagueReference<VRT, T> | undefined
): BaseOrVagueReference<VRT, T> | undefined {
  return value ? { ...value } : undefined;
}

function cloneStartOrEnd<VRT extends string, T>(value: StartOrEnd<VRT, T> | undefined): StartOrEnd<VRT, T> | undefined {
  if (!value) return undefined;
  return {
    ...(value.s ? { s: cloneBaseOrVagueReference(value.s) } : {}),
    ...(value.e ? { e: cloneBaseOrVagueReference(value.e) } : {})
  };
}

function cloneRef<VRT extends string, T>(value: BaseOrVagueReference<VRT, T> | undefined): BaseOrVagueReference<VRT, T> | undefined {
  return cloneBaseOrVagueReference(value);
}

function sameTimeReference(a: TimeReference | undefined, b: TimeReference | undefined): boolean {
  // Structural equality via JSON — TimeReferences only hold plain scalars and
  // objects, so this is sufficient and avoids pulling in a deep-equal dep.
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function dayStart(value: Date): Date {
  const next = new Date(value.getTime());
  next.setHours(0, 0, 0, 0);
  return next;
}

function dayOffsetFromAnchor(anchor: Date, value: Date): number {
  return days_between(dayStart(anchor), dayStart(value));
}

export class DateAnchorEditorState {
  draft = $state<DateInformation>(blankDateInformation());
  now = $state(new Date());
  resolveContext = $state<ResolveContext>({});

  constructor(initial: DateInformation | null = null, now?: Date, ctx?: ResolveContext) {
    this.syncFromProps(initial, now, ctx);
  }

  syncFromProps(initial: DateInformation | null, now?: Date, ctx?: ResolveContext): void {
    this.draft = cloneDateInformation(initial);
    this.now = now ? new Date(now.getTime()) : new Date();
    this.resolveContext = ctx ? { ...ctx } : {};
  }

  get anchorType(): AnchorType {
    return this.deriveAnchorType();
  }

  set anchorType(next: AnchorType) {
    this.setAnchorType(next);
  }

  resolvedStart = $derived(resolveStart(this.draft.value, this.now, this.resolveContext));
  resolvedEnd = $derived(resolveEnd(this.draft.value, this.now, this.resolveContext));
  isValid = $derived(this.validate());

  get startDatePickerValue(): DatePickerValue {
    return {
      y: this.draft.value?.y?.s as BaseOrVagueReference<VagueYearCode, number> | undefined,
      m: this.draft.value?.m?.s as BaseOrVagueReference<VagueMonthCode, number> | undefined,
      w: this.draft.value?.w?.s as BaseOrVagueReference<string, number> | undefined,
      wm: this.draft.value?.wm,
      ws: this.draft.value?.ws,
      d: this.draft.value?.d?.s as BaseOrVagueReference<VagueDayCode, number> | undefined
    };
  }

  get datePickerValue(): DatePickerValue {
    return this.startDatePickerValue;
  }

  get endDatePickerValue(): DatePickerValue {
    return {
      y: this.draft.value?.y?.e as BaseOrVagueReference<VagueYearCode, number> | undefined,
      m: this.draft.value?.m?.e as BaseOrVagueReference<VagueMonthCode, number> | undefined,
      w: this.draft.value?.w?.e as BaseOrVagueReference<string, number> | undefined,
      wm: this.draft.value?.wm,
      ws: this.draft.value?.ws,
      d: this.draft.value?.d?.e as BaseOrVagueReference<VagueDayCode, number> | undefined
    };
  }

  get timeRangeValue(): StartOrEnd<VagueMinuteCode, number> {
    return cloneStartOrEnd(this.draft.value?.i as StartOrEnd<VagueMinuteCode, number> | undefined) ?? {};
  }

  get hasExplicitEndBoundary(): boolean {
    return this.hasExplicitEnd();
  }

  get keepPinnedIfOverdue(): boolean {
    return Boolean(this.draft.po);
  }

  set keepPinnedIfOverdue(next: boolean) {
    if (next) {
      this.draft.po = true;
    } else {
      delete this.draft.po;
    }
  }

  get parentOffset(): { value: number; unit: ParentOffsetUnit } {
    const value = this.draft.value;
    const yearOffset = value?.y?.s;
    if (yearOffset?.type === 'of' && yearOffset.a === 'pr') {
      return { value: yearOffset.v, unit: 'year' };
    }

    const monthOffset = value?.m?.s;
    if (monthOffset?.type === 'of' && monthOffset.a === 'pr') {
      return { value: monthOffset.v, unit: 'month' };
    }

    const dayOffset = value?.d?.s;
    if (dayOffset?.type === 'of' && dayOffset.a === 'pr') {
      return { value: dayOffset.v, unit: 'day' };
    }

    const minuteOffset = value?.i?.s;
    if (minuteOffset?.type === 'of' && minuteOffset.a === 'pr') {
      if (minuteOffset.v % 60 === 0) {
        return { value: minuteOffset.v / 60, unit: 'hour' };
      }
      return { value: minuteOffset.v, unit: 'minute' };
    }

    return { value: 0, unit: 'day' };
  }

  get userProvidedDayOffsets(): { start: number; end: number | null } {
    const anchor = this.resolveContext.userProvided ?? this.now;
    const dayOffset = this.draft.value?.d?.s;
    const endOffset = this.draft.value?.d?.e;

    const start =
      dayOffset?.type === 'of' && dayOffset.a === 'up'
        ? dayOffset.v
        : dayOffsetFromAnchor(anchor, this.resolvedStart);

    const end =
      this.hasExplicitEnd()
        ? endOffset?.type === 'of' && endOffset.a === 'up'
          ? endOffset.v
          : dayOffsetFromAnchor(anchor, this.resolvedEnd)
        : null;

    return { start, end };
  }

  get parentDayOffsets(): { start: number; end: number | null } {
    const dayOffset = this.draft.value?.d?.s;
    const endOffset = this.draft.value?.d?.e;

    const start = dayOffset?.type === 'of' && dayOffset.a === 'pr' ? dayOffset.v : 0;

    const end = this.hasExplicitEnd()
      ? endOffset?.type === 'of' && endOffset.a === 'pr'
        ? endOffset.v
        : start
      : null;

    return { start, end };
  }

  setDatePickerValue(next: DatePickerValue): void {
    this.setStartDatePickerValue(next);
  }

  setStartDatePickerValue(next: DatePickerValue): void {
    this.ensureValue();
    this.draft.value.y = this.replaceStartRef(this.draft.value.y, next.y as BaseOrVagueReference<string, number> | undefined);
    this.draft.value.m = this.replaceStartRef(this.draft.value.m, next.m as BaseOrVagueReference<string, number> | undefined);
    this.draft.value.w = this.replaceStartRef(this.draft.value.w, next.w as BaseOrVagueReference<string, number> | undefined);
    this.draft.value.d = this.replaceStartRef(this.draft.value.d, next.d as BaseOrVagueReference<string, number> | undefined);
    this.draft.value.wm = next.w ? next.wm ?? this.draft.value.wm ?? 'ord' : undefined;
    this.draft.value.ws = next.wm === 'row' ? next.ws ?? this.draft.value.ws ?? 1 : undefined;
  }

  setEndDatePickerValue(next: DatePickerValue): void {
    this.ensureValue();
    this.draft.value.y = this.replaceEndRef(this.draft.value.y, next.y as BaseOrVagueReference<string, number> | undefined);
    this.draft.value.m = this.replaceEndRef(this.draft.value.m, next.m as BaseOrVagueReference<string, number> | undefined);
    this.draft.value.w = this.replaceEndRef(this.draft.value.w, next.w as BaseOrVagueReference<string, number> | undefined);
    this.draft.value.d = this.replaceEndRef(this.draft.value.d, next.d as BaseOrVagueReference<string, number> | undefined);
    this.draft.value.wm = next.w ? next.wm ?? this.draft.value.wm ?? 'ord' : this.draft.value.wm;
    this.draft.value.ws = next.wm === 'row' ? next.ws ?? this.draft.value.ws ?? 1 : this.draft.value.ws;
  }

  setTimeRangeValue(next: StartOrEnd<VagueMinuteCode, number>): void {
    this.ensureValue();
    this.draft.value.i = cloneStartOrEnd(next as StartOrEnd<string, number>);
  }

  setHasExplicitEnd(next: boolean): void {
    this.ensureValue();

    if (!next) {
      // Short-circuit when already in the target state. clearEndRef always
      // produces new objects when the start side is set, so re-running this
      // unconditionally would mutate draft.value.* on every call, feeding
      // effects that read those fields back into themselves (infinite loop).
      if (!this.hasExplicitEnd()) return;
      this.draft.value.y = this.clearEndRef(this.draft.value.y);
      this.draft.value.m = this.clearEndRef(this.draft.value.m);
      this.draft.value.w = this.clearEndRef(this.draft.value.w);
      this.draft.value.d = this.clearEndRef(this.draft.value.d);
      this.draft.value.i = this.clearEndRef(this.draft.value.i);
      return;
    }

    if (this.hasExplicitEnd()) return;

    this.draft.value.y = this.replaceEndRef(this.draft.value.y, cloneRef(this.draft.value.y?.s));
    this.draft.value.m = this.replaceEndRef(this.draft.value.m, cloneRef(this.draft.value.m?.s));
    this.draft.value.w = this.replaceEndRef(this.draft.value.w, cloneRef(this.draft.value.w?.s));
    this.draft.value.d = this.replaceEndRef(this.draft.value.d, cloneRef(this.draft.value.d?.s));
    this.draft.value.i = this.replaceEndRef(this.draft.value.i, cloneRef(this.draft.value.i?.s));
  }

  setParentOffset(rawValue: number, unit: ParentOffsetUnit): void {
    this.ensureValue();

    const safeValue = Number.isFinite(rawValue) ? Math.trunc(rawValue) : 0;

    // Build the desired single-field TimeReference for this parent offset.
    let target: TimeReference;
    if (unit === 'year') {
      target = { y: { s: { type: 'of', v: safeValue, a: 'pr' } } };
    } else if (unit === 'month') {
      target = { m: { s: { type: 'of', v: safeValue, a: 'pr' } } };
    } else if (unit === 'day') {
      target = { d: { s: { type: 'of', v: safeValue, a: 'pr' } } };
    } else {
      target = {
        i: {
          s: {
            type: 'of',
            v: unit === 'hour' ? safeValue * 60 : safeValue,
            a: 'pr'
          }
        }
      };
    }

    // No-op if the existing value already matches — this is critical because
    // effect 454 in DateAnchorEditor fires whenever editor.anchorType (which
    // tracks draft.value) changes, and unconditionally writing a freshly
    // constructed object here would loop: new assignment → deps dirty →
    // effect refires → new assignment → …
    const current = this.draft.value as TimeReference | undefined;
    if (current && sameTimeReference(current, target)) return;

    this.draft.value = target;
  }

  setAnchorOnly(anchor: 'up' | 'pr'): void {
    this.ensureValue();
    const target: TimeReference = {
      d: {
        s: { type: 'of', v: 0, a: anchor }
      }
    };
    const current = this.draft.value as TimeReference | undefined;
    if (current && sameTimeReference(current, target)) return;
    this.draft.value = target;
  }

  setUserProvidedDayOffsets(start: number, end: number | null = null): void {
    this.ensureValue();

    const currentMinutes = cloneStartOrEnd(this.draft.value.i as StartOrEnd<string, number> | undefined);
    const target: TimeReference = {
      d: {
        s: { type: 'of', v: Math.trunc(start), a: 'up' },
        ...(end !== null ? { e: { type: 'of', v: Math.trunc(end), a: 'up' } } : {})
      },
      ...(currentMinutes ? { i: currentMinutes } : {})
    };

    const current = this.draft.value as TimeReference | undefined;
    if (current && sameTimeReference(current, target)) return;
    this.draft.value = target;
  }

  setParentDayOffsets(start: number, end: number | null = null): void {
    this.ensureValue();

    const currentMinutes = cloneStartOrEnd(this.draft.value.i as StartOrEnd<string, number> | undefined);
    const target: TimeReference = {
      d: {
        s: { type: 'of', v: Math.trunc(start), a: 'pr' },
        ...(end !== null ? { e: { type: 'of', v: Math.trunc(end), a: 'pr' } } : {})
      },
      ...(currentMinutes ? { i: currentMinutes } : {})
    };

    const current = this.draft.value as TimeReference | undefined;
    if (current && sameTimeReference(current, target)) return;
    this.draft.value = target;
  }

  private deriveAnchorType(): AnchorType {
    const v = this.draft.value;
    if (!v) return 'nw';

    const checkRef = (ref: BaseOrVagueReference<any, any> | undefined): AnchorType | null => {
      if (ref && ref.type === 'of') {
        return ref.a;
      }
      return null;
    };

    const checkSE = (se: StartOrEnd<any, any> | undefined): AnchorType | null => {
      if (!se) return null;
      return checkRef(se.s) || checkRef(se.e);
    };

    const found = checkSE(v.y) || checkSE(v.m) || checkSE(v.w) || checkSE(v.d) || checkSE(v.i);
    if (found) return found;

    // If it has dates but no offsets, it's either absolute (which UI treats as 'up')
    // or just 'nw' if it's completely empty.
    if (!hasAnyDateField(v)) return 'nw';
    return 'up';
  }

  setAnchorType(next: AnchorType): void {
    if (next === 'nw') {
      this.draft.value = {};
      return;
    }

    const current = this.deriveAnchorType();
    if (current === next) return;

    if (next === 'up') {
      this.draft.value = explicitTimeReference(this.resolvedStart, this.hasExplicitEnd() ? this.resolvedEnd : null);
      return;
    }

    if (next === 'pr') {
      const currentDayOffset = current === 'pr' ? this.parentDayOffsets.start : 0;
      this.setParentDayOffsets(currentDayOffset, null);
    }
  }

  validate(): boolean {
    if (this.anchorType === 'nw') return true;
    return hasAnyDateField(this.draft.value);
  }

  private hasExplicitEnd(): boolean {
    return Boolean(
      this.draft.value?.y?.e ||
      this.draft.value?.m?.e ||
      this.draft.value?.w?.e ||
      this.draft.value?.d?.e ||
      this.draft.value?.i?.e
    );
  }

  private ensureValue(): void {
    this.draft.value ??= {};
  }

  private replaceStartRef(
    existing: StartOrEnd<string, number> | undefined,
    nextStart: BaseOrVagueReference<string, number> | undefined
  ): StartOrEnd<string, number> | undefined {
    if (!nextStart && !existing?.e) {
      return undefined;
    }
    return {
      ...(existing?.e ? { e: cloneRef(existing.e) } : {}),
      ...(nextStart ? { s: cloneRef(nextStart) } : {})
    };
  }

  private replaceEndRef(
    existing: StartOrEnd<string, number> | undefined,
    nextEnd: BaseOrVagueReference<string, number> | undefined
  ): StartOrEnd<string, number> | undefined {
    if (!nextEnd && !existing?.s) {
      return undefined;
    }
    return {
      ...(existing?.s ? { s: cloneRef(existing.s) } : {}),
      ...(nextEnd ? { e: cloneRef(nextEnd) } : {})
    };
  }

  private clearEndRef(existing: StartOrEnd<string, number> | undefined): StartOrEnd<string, number> | undefined {
    if (!existing?.s) {
      return undefined;
    }
    return { s: cloneRef(existing.s) };
  }
}
