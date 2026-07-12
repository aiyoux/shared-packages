import { describe, expect, it } from 'vitest';
import type { AdditionalWithId } from './types.ts';
import {
  createMeasureAdditional,
  fromCanonical,
  isMeasureAdditional,
  isRollupMeasureMarker,
  readMeasureAdditional,
  setMeasureComputed,
  setMeasureDesc,
  setMeasureUnit,
  setMeasureValue,
  setMeasureWeight,
  toCanonical
} from './measure-additional.ts';

describe('toCanonical / fromCanonical (mirror surql factors)', () => {
  it('converts distance units to meters', () => {
    expect(toCanonical('distance', 1, 'km')).toBe(1000);
    expect(toCanonical('distance', 1, 'mi')).toBeCloseTo(1609.344, 5);
    expect(toCanonical('distance', 1, 'ft')).toBeCloseTo(0.3048, 5);
    expect(toCanonical('distance', 1, 'in')).toBeCloseTo(0.0254, 5);
    expect(toCanonical('distance', 100, 'cm')).toBe(1);
    expect(toCanonical('distance', 1000, 'mm')).toBe(1);
    expect(toCanonical('distance', 5, 'm')).toBe(5);
  });

  it('converts duration units to seconds', () => {
    expect(toCanonical('duration', 1, 'h')).toBe(3600);
    expect(toCanonical('duration', 1, 'm')).toBe(60);
    expect(toCanonical('duration', 30, 's')).toBe(30);
  });

  it('round-trips through fromCanonical', () => {
    expect(fromCanonical('distance', 1609.344, 'mi')).toBeCloseTo(1, 9);
    expect(fromCanonical('duration', 3600, 'h')).toBeCloseTo(1, 9);
    expect(fromCanonical('duration', 90, 'm')).toBe(1.5);
  });

  it('falls back to factor 1 for unknown units', () => {
    expect(toCanonical('distance', 7, 'parsecs')).toBe(7);
    expect(toCanonical('duration', 7, 'weeks')).toBe(7);
  });
});

describe('createMeasureAdditional', () => {
  it('builds a manual distance with meters derived from value+unit', () => {
    const add = createMeasureAdditional('distance', { value: 5, unit: 'km' }) as any;
    expect(add.type).toBe('distance');
    expect(add.value).toBe(5);
    expect(add.unit).toBe('km');
    expect(add.meters).toBe(5000);
    expect(add.mode).toBeUndefined();
    expect(add.computed).toBeUndefined();
    expect(add.id).toBeTruthy();
  });

  it('builds a manual duration with seconds derived from value+unit', () => {
    const add = createMeasureAdditional('duration', { value: 2, unit: 'h' }) as any;
    expect(add.seconds).toBe(7200);
  });

  it('builds a rollup marker when computed:true (no value/canonical)', () => {
    const add = createMeasureAdditional('distance', { computed: true, unit: 'mi' }) as any;
    expect(add.mode).toBe('rollup');
    expect(add.unit).toBe('mi');
    expect(add.value).toBeUndefined();
    expect(add.meters).toBeUndefined();
    expect(isRollupMeasureMarker(add)).toBe(true);
  });
});

describe('readMeasureAdditional', () => {
  it('reads a manual distance', () => {
    const add = { id: 'd1', type: 'distance', value: 3, unit: 'km', meters: 3000 } as AdditionalWithId;
    expect(readMeasureAdditional(add)).toMatchObject({
      kind: 'distance', value: 3, unit: 'km', canonical: 3000, computed: false, weight: 100
    });
  });

  it('reads a marker as computed with zeroed value/canonical', () => {
    const add = { id: 'd2', type: 'duration', mode: 'rollup', unit: 'm', weight: 50 } as AdditionalWithId;
    expect(readMeasureAdditional(add)).toMatchObject({
      kind: 'duration', computed: true, value: 0, canonical: 0, weight: 50, unit: 'm'
    });
  });

  it('returns null for non-measure additionals', () => {
    expect(readMeasureAdditional({ id: 'x', type: 'pg' } as AdditionalWithId)).toBeNull();
    expect(isMeasureAdditional({ type: 'pg' })).toBe(false);
  });
});

describe('setMeasureValue', () => {
  it('updates value and recomputes meters', () => {
    const add = { id: 'd1', type: 'distance', value: 1, unit: 'km', meters: 1000 } as AdditionalWithId;
    const next = setMeasureValue(add, 2) as any;
    expect(next.value).toBe(2);
    expect(next.meters).toBe(2000);
    expect(next.unit).toBe('km');
    expect(next.id).toBe('d1');
  });

  it('is a no-op on a rollup marker', () => {
    const marker = { id: 'd2', type: 'distance', mode: 'rollup', unit: 'm' } as AdditionalWithId;
    expect(setMeasureValue(marker, 5)).toBe(marker);
  });
});

describe('setMeasureUnit', () => {
  it('rescales the display value while preserving the canonical quantity (manual)', () => {
    const add = { id: 'd1', type: 'distance', value: 1000, unit: 'm', meters: 1000 } as AdditionalWithId;
    const next = setMeasureUnit(add, 'km') as any;
    expect(next.unit).toBe('km');
    expect(next.meters).toBe(1000);
    expect(next.value).toBeCloseTo(1, 9);
  });

  it('only changes the unit field on a marker', () => {
    const marker = { id: 'd2', type: 'duration', mode: 'rollup', unit: 's', weight: 100 } as AdditionalWithId;
    const next = setMeasureUnit(marker, 'h') as any;
    expect(next.unit).toBe('h');
    expect(next.mode).toBe('rollup');
    expect(next.value).toBeUndefined();
    expect(next.seconds).toBeUndefined();
  });
});

describe('setMeasureComputed', () => {
  it('manual → marker preserves id/unit/weight/desc', () => {
    const add = { id: 'd1', type: 'distance', value: 5, unit: 'mi', meters: 8046.72, weight: 30, desc: 'run' } as AdditionalWithId;
    const next = setMeasureComputed(add, true) as any;
    expect(next.id).toBe('d1');
    expect(next.mode).toBe('rollup');
    expect(next.unit).toBe('mi');
    expect(next.weight).toBe(30);
    expect(next.desc).toBe('run');
    expect(next.value).toBeUndefined();
    expect(next.meters).toBeUndefined();
  });

  it('marker → manual seeds a zero value in the marker unit', () => {
    const marker = { id: 'd2', type: 'duration', mode: 'rollup', unit: 'm', weight: 50 } as AdditionalWithId;
    const next = setMeasureComputed(marker, false) as any;
    expect(next.mode).toBeUndefined();
    expect(next.value).toBe(0);
    expect(next.unit).toBe('m');
    expect(next.seconds).toBe(0);
    expect(next.id).toBe('d2');
  });

  it('is a no-op when already in the target state', () => {
    const marker = { id: 'd2', type: 'distance', mode: 'rollup', unit: 'm' } as AdditionalWithId;
    expect(setMeasureComputed(marker, true)).toBe(marker);
  });
});

describe('setMeasureWeight / setMeasureDesc', () => {
  it('updates weight preserving everything else', () => {
    const add = { id: 'd1', type: 'distance', value: 1, unit: 'km', meters: 1000, weight: 100 } as AdditionalWithId;
    const next = setMeasureWeight(add, 25) as any;
    expect(next.weight).toBe(25);
    expect(next.meters).toBe(1000);
    expect(next.value).toBe(1);
  });

  it('clears desc with null', () => {
    const add = { id: 'd1', type: 'distance', value: 1, unit: 'm', meters: 1, desc: 'old' } as AdditionalWithId;
    const next = setMeasureDesc(add, null) as any;
    expect(next.desc).toBeNull();
  });
});

describe('measure mutator round-trip', () => {
  it('value+unit+weight+desc+computed compose without leaking manual fields into a marker', () => {
    let add: AdditionalWithId = createMeasureAdditional('distance', { value: 1000, unit: 'm' });
    add = setMeasureUnit(add, 'km') as AdditionalWithId;
    add = setMeasureWeight(add, 33) as AdditionalWithId;
    add = setMeasureDesc(add, 'loop') as AdditionalWithId;
    add = setMeasureComputed(add, true) as AdditionalWithId;

    const shape = readMeasureAdditional(add);
    expect(shape).toMatchObject({ kind: 'distance', computed: true, weight: 33, desc: 'loop', unit: 'km' });
    expect((add as any).value).toBeUndefined();
    expect((add as any).meters).toBeUndefined();
  });
});