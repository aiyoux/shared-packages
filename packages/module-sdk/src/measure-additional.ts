import type { AdditionalWithId } from './types.ts';

/**
 * Helpers for the `distance` and `duration` additionals.
 *
 * These two are structurally identical (a scalar `value` in a display `unit`
 * plus a canonical SI quantity), so one set of helpers handles both. The
 * canonical conversion factors MIRROR the server functions
 * `fn::distance_to_meters` / `fn::meters_to_distance` (surql/runtime/
 * progress_calculation/modules/distance.surql) and `fn::duration_to_seconds` /
 * `fn::seconds_to_duration` (.../duration.surql). Keep them in lockstep.
 *
 * Wire shapes (see computed_additionals.surql for the split rationale):
 *  - Manual value:   `{ id, type, value, unit, meters|seconds, weight?, desc? }`
 *  - Rollup MARKER:  `{ id, type, mode:'rollup', unit?, weight?, desc? }`
 *  - Computed VALUE: server-owned in `computed_additionals` (never written here).
 *
 * Clients never write `computed:true`; the rollup opt-in IS the marker form.
 */

export type MeasureKind = 'distance' | 'duration';

export interface MeasureUnit {
  value: string;
  label: string;
  /** Multiplier to the canonical SI unit (meters for distance, seconds for duration). */
  factor: number;
}

// Order = display order in the editor. Factors mirror fn::distance_to_meters.
export const DISTANCE_UNITS: MeasureUnit[] = [
  { value: 'm', label: 'meters', factor: 1 },
  { value: 'km', label: 'kilometers', factor: 1000 },
  { value: 'cm', label: 'centimeters', factor: 0.01 },
  { value: 'mm', label: 'millimeters', factor: 0.001 },
  { value: 'mi', label: 'miles', factor: 1609.344 },
  { value: 'ft', label: 'feet', factor: 0.3048 },
  { value: 'in', label: 'inches', factor: 0.0254 }
];

// Factors mirror fn::duration_to_seconds.
export const DURATION_UNITS: MeasureUnit[] = [
  { value: 's', label: 'seconds', factor: 1 },
  { value: 'm', label: 'minutes', factor: 60 },
  { value: 'h', label: 'hours', factor: 3600 }
];

const DISTANCE_FACTOR: Record<string, number> = Object.fromEntries(
  DISTANCE_UNITS.map((u) => [u.value, u.factor])
);
const DURATION_FACTOR: Record<string, number> = Object.fromEntries(
  DURATION_UNITS.map((u) => [u.value, u.factor])
);

function factorFor(kind: MeasureKind, unit: string): number {
  const table = kind === 'distance' ? DISTANCE_FACTOR : DURATION_FACTOR;
  return table[unit] ?? (kind === 'distance' ? 1 : 1);
}

/** Canonical SI quantity for a display value+unit (meters or seconds). */
export function toCanonical(kind: MeasureKind, value: number, unit: string): number {
  return Number(value ?? 0) * factorFor(kind, unit);
}

/** Display value for a canonical SI quantity in a given unit. */
export function fromCanonical(kind: MeasureKind, canonical: number, unit: string): number {
  const f = factorFor(kind, unit);
  return Number(canonical ?? 0) / (f || 1);
}

export function isMeasureAdditional(additional: AdditionalWithId | Record<string, any>): boolean {
  const t = (additional as any).type;
  return t === 'distance' || t === 'duration';
}

export function isRollupMeasureMarker(additional: AdditionalWithId | Record<string, any>): boolean {
  return isMeasureAdditional(additional) && (additional as any).mode === 'rollup';
}

export interface MeasureShape {
  kind: MeasureKind;
  /** Display value in `unit`. 0 for a marker (no own value). */
  value: number;
  unit: string;
  /** Canonical SI quantity (meters or seconds). 0 for a marker. */
  canonical: number;
  computed: boolean;
  weight: number;
  desc: string | null;
}

const DEFAULT_UNIT: Record<MeasureKind, string> = { distance: 'm', duration: 's' };

export function readMeasureAdditional(
  additional: AdditionalWithId | Record<string, any>
): MeasureShape | null {
  if (!isMeasureAdditional(additional)) return null;
  const a = additional as any;
  const kind = a.type as MeasureKind;
  const isMarker = a.mode === 'rollup';
  const unit = a.unit ?? DEFAULT_UNIT[kind];
  const canonicalField = kind === 'distance' ? 'meters' : 'seconds';
  const canonical = isMarker ? 0 : Number(a[canonicalField] ?? 0);
  const value = isMarker ? 0 : Number(a.value ?? 0);
  return {
    kind,
    value,
    unit,
    canonical,
    computed: isMarker,
    weight: Number(a.weight ?? 100),
    desc: (a.desc ?? null) as string | null
  };
}

export interface CreateMeasureOptions {
  value?: number;
  unit?: string;
  weight?: number;
  desc?: string | null;
  /** When true, emit a rollup MARKER instead of a manual value. */
  computed?: boolean;
}

export function createMeasureAdditional(
  kind: MeasureKind,
  opts: CreateMeasureOptions = {}
): AdditionalWithId {
  const unit = opts.unit ?? DEFAULT_UNIT[kind];
  const weight = Number.isFinite(opts.weight) ? Number(opts.weight) : 100;
  const desc = opts.desc ?? null;
  const id = crypto.randomUUID();
  const canonicalField = kind === 'distance' ? 'meters' : 'seconds';

  if (opts.computed) {
    return {
      id,
      type: kind,
      mode: 'rollup',
      unit,
      weight,
      desc
    } as unknown as AdditionalWithId;
  }

  const value = Number.isFinite(opts.value) ? Number(opts.value) : 0;
  return {
    id,
    type: kind,
    value,
    unit,
    [canonicalField]: toCanonical(kind, value, unit),
    weight,
    desc
  } as unknown as AdditionalWithId;
}

function canonicalFieldOf(kind: MeasureKind): 'meters' | 'seconds' {
  return kind === 'distance' ? 'meters' : 'seconds';
}

/** Toggle between a manual value and a rollup MARKER, preserving id/unit/weight/desc. */
export function setMeasureComputed<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  computed: boolean
): T {
  const shape = readMeasureAdditional(additional);
  if (!shape) return additional;
  const a = additional as any;
  const alreadyMarker = a.mode === 'rollup';
  if (computed === alreadyMarker) return additional;
  if (computed) {
    return {
      id: a.id,
      type: shape.kind,
      mode: 'rollup',
      unit: a.unit ?? DEFAULT_UNIT[shape.kind],
      weight: a.weight ?? 100,
      desc: a.desc ?? null
    } as unknown as T;
  }
  // Marker → manual: seed a 0 value in the marker's display unit.
  const unit = a.unit ?? DEFAULT_UNIT[shape.kind];
  return {
    id: a.id,
    type: shape.kind,
    value: 0,
    unit,
    [canonicalFieldOf(shape.kind)]: 0,
    weight: a.weight ?? 100,
    desc: a.desc ?? null
  } as unknown as T;
}

/** Set the display value (recomputes the canonical SI quantity). Manual only. */
export function setMeasureValue<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  value: number
): T {
  const shape = readMeasureAdditional(additional);
  if (!shape || shape.computed) return additional;
  const a = additional as any;
  const v = Number.isFinite(value) ? Number(value) : 0;
  return {
    ...a,
    value: v,
    [canonicalFieldOf(shape.kind)]: toCanonical(shape.kind, v, shape.unit)
  } as T;
}

/** Set the display unit. For manual entries the canonical quantity is preserved
 *  (the display value is rescaled); for markers only the unit field changes. */
export function setMeasureUnit<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  unit: string
): T {
  const shape = readMeasureAdditional(additional);
  if (!shape) return additional;
  const a = additional as any;
  if (shape.computed) {
    return { ...a, unit } as T;
  }
  // Preserve canonical quantity: recompute the display value in the new unit.
  const value = fromCanonical(shape.kind, shape.canonical, unit);
  return {
    ...a,
    unit,
    value,
    [canonicalFieldOf(shape.kind)]: toCanonical(shape.kind, value, unit)
  } as T;
}

export function setMeasureWeight<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  weight: number
): T {
  const shape = readMeasureAdditional(additional);
  if (!shape) return additional;
  const a = additional as any;
  return { ...a, weight: Number.isFinite(weight) ? Number(weight) : 100 } as T;
}

export function setMeasureDesc<T extends AdditionalWithId | Record<string, any>>(
  additional: T,
  desc: string | null
): T {
  const shape = readMeasureAdditional(additional);
  if (!shape) return additional;
  const a = additional as any;
  return { ...a, desc: desc ?? null } as T;
}