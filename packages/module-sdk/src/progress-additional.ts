import type { AdditionalWithId } from './types.ts';

/**
 * Helpers for the "progress" (user-checkbox) additional.
 *
 * Wire shapes (see computed_additionals.surql for the split rationale):
 *  - Manual value (authored):   `{ id, type: 'pg', prog_type: { ch | pct }, weight, desc }`
 *  - Rollup MARKER (authored):  `{ id, type: 'pg', mode: 'rollup', base_prog_type, weight, desc, offset_base? }`
 *  - Computed VALUE (server-owned, in `item.computed_additionals`, never
 *    written by clients): marker shape + calculated `prog_type` + `computed: true`.
 *
 * The `computed` option/flag on this API means "this progress is a rollup":
 * creating/toggling with `computed: true` emits the MARKER form. To display a
 * rollup's live value, resolve the marker against the item via
 * `resolveAdditionalForDisplay` / `readComputedAdditional` (computed-additionals.ts).
 */

export interface ProgressAdditionalData {
  checked: boolean;
}

export type ProgressKind = 'check' | 'percentage';
export type CheckProgressValue = 'True' | 'False' | 'Partial' | 'NA' | 'WontDo';

export interface CreateProgressOptions {
  /** 'check' (boolean) or 'percentage' (0-100). Default 'check'. */
  kind?: ProgressKind;
  /**
   * Initial value.
   * - For 'check': boolean (true→'t', false→'f') or 'True'|'False'|'Partial'|'NA'|'WontDo'.
   * - For 'percentage': number 0-100 (clamped).
   * Default: 'False' / 0.
   */
  value?: boolean | number | CheckProgressValue;
  /** When true, the value is auto-calculated server-side from descendants. */
  computed?: boolean;
  /** Relative weight when this progress contributes to a computed parent. Default 100. */
  weight?: number;
  /** Optional human-readable description. */
  desc?: string | null;
}

export interface ProgressShape {
  kind: ProgressKind;
  /** For check kind: 'True' | 'False' | 'Partial' | 'NA' | 'WontDo'. For percentage: number 0-100. */
  value: CheckProgressValue | number;
  computed: boolean;
  weight: number;
  desc: string | null;
}

/**
 * Reads the kind, value, computed flag, weight, and desc off any of the
 * progress additional shapes (flat, wrapped, simple). Returns null when the
 * additional isn't a progress one.
 */
export function readProgressAdditional(
  additional: AdditionalWithId | Record<string, any>
): ProgressShape | null {
  if (!isProgressAdditional(additional)) return null;
  const addObj = additional as any;
  // A rollup marker has no live prog_type; its configured base doubles as the
  // fallback value. The LIVE value is the matching computed_additionals entry
  // (which carries prog_type + computed: true and reads through this same
  // branch-free path).
  const isMarker = addObj.mode === 'rollup';
  const prog_type = addObj.prog_type ?? (isMarker ? addObj.base_prog_type : undefined);
  const computed = isMarker || Boolean(addObj.computed ?? false);
  const weight = Number(addObj.weight ?? 100);
  const desc = addObj.desc as string | null;

  if (!prog_type) {
    return { kind: 'check', value: 'False', computed, weight, desc };
  }
  if ('ch' in prog_type) {
    const cv = prog_type.ch;
    return { kind: 'check', value: cv === 't' ? 'True' : cv === 'p' ? 'Partial' : cv === 'na' ? 'NA' : cv === 'wd' ? 'WontDo' : 'False', computed, weight, desc };
  }
  if ('pct' in prog_type) {
    return { kind: 'percentage', value: Number(prog_type.pct ?? 0), computed, weight, desc };
  }
  return { kind: 'check', value: 'False', computed, weight, desc };
}

export function isProgressAdditional(
  additional: AdditionalWithId | Record<string, any>
): boolean {
  return (additional as any).type === 'pg';
}

/** True when the authored pg entry is a rollup opt-in marker (no own value). */
export function isRollupProgressMarker(
  additional: AdditionalWithId | Record<string, any>
): boolean {
  return (additional as any).type === 'pg' && (additional as any).mode === 'rollup';
}

export function getProgressAdditionalData(
  additional: AdditionalWithId | Record<string, any>
): ProgressAdditionalData | null {
  if (!isProgressAdditional(additional)) return null;
  const prog_type = (additional as any).prog_type;

  if (!prog_type) {
    return { checked: false };
  }

  if ('ch' in prog_type) {
    return { checked: prog_type.ch === 't' || prog_type.ch === 'p' };
  } else if ('pct' in prog_type) {
    return { checked: Number(prog_type.pct ?? 0) >= 100 };
  }

  return { checked: false };
}

/**
 * Create a progress additional in the flat wire shape that the server-side
 * `fn::propagate_progress_change` understands:
 *   `{ id, type: 'pg', prog_type: { ch | pct }, weight, computed, desc }`
 *
 * Back-compat: calling with a boolean (`createProgressAdditional(true)`) is
 * equivalent to `createProgressAdditional({ kind: 'check', value: true })`.
 */
export function createProgressAdditional(opts?: boolean | CreateProgressOptions): AdditionalWithId {
  const o: CreateProgressOptions = typeof opts === 'boolean'
    ? { kind: 'check', value: opts }
    : (opts ?? {});
  const kind: ProgressKind = o.kind ?? 'check';
  const computed = Boolean(o.computed ?? false);
  const weight = Number.isFinite(o.weight) ? Number(o.weight) : 100;
  const desc = o.desc ?? null;
  const id = crypto.randomUUID();

  let prog_type: { ch: string } | { pct: number };
  if (kind === 'check') {
    let ch: 't' | 'f' | 'p' | 'na' | 'wd' = 'f';
    if (o.value === true) ch = 't';
    else if (o.value === 'True') ch = 't';
    else if (o.value === 'Partial') ch = 'p';
    else if (o.value === 'NA') ch = 'na';
    else if (o.value === 'WontDo') ch = 'wd';
    prog_type = { ch };
  } else {
    let pct = 0;
    if (typeof o.value === 'number') pct = Math.max(0, Math.min(100, o.value));
    else if (o.value === true) pct = 100;
    prog_type = { pct };
  }

  if (computed) {
    // Rollup opt-in MARKER: the server derives the value into
    // computed_additionals; the configured type becomes the base/fallback.
    return {
      id,
      type: 'pg',
      mode: 'rollup',
      base_prog_type: prog_type,
      weight,
      desc
    } as unknown as AdditionalWithId;
  }

  return {
    id,
    type: 'pg',
    prog_type,
    weight,
    desc
  } as unknown as AdditionalWithId;
}

/**
 * Toggle a progress additional between manual and rollup. Rollup = the
 * authored MARKER form (`mode: 'rollup'`, no own value — the server derives
 * it into computed_additionals). Toggling back to manual seeds the value from
 * the marker's configured base type. The id is preserved in both directions
 * so cache patches and references stay stable. Returns a new object so cache
 * reactivity sees the change.
 */
export function setProgressAdditionalComputed<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  computed: boolean
): T {
  if (!isProgressAdditional(additional)) return additional;
  const addObj = additional as any;
  const alreadyMarker = addObj.mode === 'rollup';
  if (computed === alreadyMarker) return additional;

  if (computed) {
    return {
      id: addObj.id,
      type: 'pg',
      mode: 'rollup',
      base_prog_type: addObj.prog_type ?? { ch: 'f' },
      weight: addObj.weight ?? 100,
      desc: addObj.desc ?? null,
      ...(addObj.offset_base ? { offset_base: addObj.offset_base } : {})
    } as unknown as T;
  }
  return {
    id: addObj.id,
    type: 'pg',
    prog_type: addObj.base_prog_type ?? { ch: 'f' },
    weight: addObj.weight ?? 100,
    desc: addObj.desc ?? null
  } as unknown as T;
}

/**
 * Convert an additional between 'check' and 'percentage' kinds. The current
 * value is preserved as best-effort (True ↔ 100, False ↔ 0, Partial ↔ 50).
 */
export function setProgressAdditionalKind<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  kind: ProgressKind
): T {
  const shape = readProgressAdditional(additional);
  if (!shape || shape.kind === kind) return additional;
  // Translate the value across kinds so existing intent is preserved.
  let nextValue: CheckProgressValue | number;
  if (kind === 'percentage') {
    nextValue = shape.value === 'True' ? 100 : shape.value === 'Partial' ? 50 : 0;
  } else {
    const pct = typeof shape.value === 'number' ? shape.value : 0;
    nextValue = pct >= 100 ? 'True' : pct > 0 ? 'Partial' : 'False';
  }
  // Build a fresh additional preserving id, computed, weight, desc.
  const addObj = additional as any;
  const replacement = createProgressAdditional({
    kind,
    value: nextValue,
    computed: shape.computed,
    weight: shape.weight,
    desc: shape.desc
  }) as any;
  // Re-use the original id so cache patches and references stay stable.
  replacement.id = addObj.id ?? replacement.id;
  return replacement as T;
}

export function patchProgressAdditional<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  data: ProgressAdditionalData
): T {
  const shape = readProgressAdditional(additional);
  if (!shape) return additional;

  let nextValue: CheckProgressValue | number;
  if (shape.kind === 'percentage') {
    nextValue = data.checked ? 100 : 0;
  } else {
    nextValue = data.checked ? 'True' : 'False';
  }

  const replacement = createProgressAdditional({
    kind: shape.kind,
    value: nextValue,
    computed: false,
    weight: shape.weight,
    desc: shape.desc
  }) as any;

  // Strip legacy short fields AND marker fields: directly setting a value
  // always yields a clean MANUAL entry (a leftover `mode: 'rollup'` would
  // make the server treat it as a marker again).
  // Also drop updated_at: a modified entry must get a FRESH client-clock
  // stamp at queue time or its edit loses the per-id LWW merge to any
  // concurrent write (queueOp only stamps entries lacking updated_at).
  const { t, d, c, p, mode, base_prog_type, offset_base, computed, updated_at, ...rest } = additional as any;
  replacement.id = rest.id ?? replacement.id;

  return { ...rest, ...replacement } as T;
}

/**
 * Set the manual value of a progress additional (check state or percentage),
 * preserving kind, weight, and desc. Always produces a clean MANUAL entry —
 * any leftover `mode: 'rollup'` marker fields are stripped so the server
 * doesn't treat the result as a rollup again. The id is preserved.
 *
 * For a rollup marker, callers should switch to manual via
 * `setProgressAdditionalComputed(additional, false)` first; this helper is
 * meant for the manual-value editing path.
 */
export function setProgressAdditionalValue<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  value: CheckProgressValue | number
): T {
  const shape = readProgressAdditional(additional);
  if (!shape) return additional;
  const replacement = createProgressAdditional({
    kind: shape.kind,
    value,
    computed: false,
    weight: shape.weight,
    desc: shape.desc
  }) as any;
  const { t, d, c, p, mode, base_prog_type, offset_base, computed, updated_at, ...rest } = additional as any;
  replacement.id = rest.id ?? replacement.id;
  return { ...rest, ...replacement } as T;
}

/**
 * Rebuild a progress additional preserving kind, value, computed-ness, and
 * marker extras (`offset_base`) while applying `weight`/`desc` overrides. Used
 * by `setProgressAdditionalWeight` / `setProgressAdditionalDesc`. The id is
 * preserved and legacy short fields + `updated_at` are dropped so the rebuilt
 * entry gets a fresh client-clock stamp at queue time.
 */
function rebuildProgress<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  overrides: { weight?: number; desc?: string | null }
): T {
  const shape = readProgressAdditional(additional);
  if (!shape) return additional;
  const replacement = createProgressAdditional({
    kind: shape.kind,
    value: shape.value,
    computed: shape.computed,
    weight:
      overrides.weight !== undefined
        ? Number.isFinite(overrides.weight) ? Number(overrides.weight) : 100
        : shape.weight,
    desc: overrides.desc !== undefined ? overrides.desc : shape.desc
  }) as any;
  const { t, d, c, p, updated_at, ...rest } = additional as any;
  replacement.id = rest.id ?? replacement.id;
  return { ...rest, ...replacement } as T;
}

/**
 * Set the relative weight of a progress additional (its contribution to a
 * computed parent). Preserves kind, value, computed-ness, desc, id, and — for
 * rollup markers — `offset_base`.
 */
export function setProgressAdditionalWeight<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  weight: number
): T {
  return rebuildProgress(additional, { weight });
}

/**
 * Set the optional human-readable description of a progress additional.
 * Pass `null` to clear. Preserves kind, value, computed-ness, weight, id, and
 * marker extras.
 */
export function setProgressAdditionalDesc<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  desc: string | null
): T {
  return rebuildProgress(additional, { desc });
}
