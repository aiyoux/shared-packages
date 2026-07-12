import { describe, expect, it } from 'vitest';
import type { AdditionalWithId } from './types.ts';
import {
  createProgressAdditional,
  getProgressAdditionalData,
  readProgressAdditional,
  setProgressAdditionalComputed,
  setProgressAdditionalDesc,
  setProgressAdditionalKind,
  setProgressAdditionalValue,
  setProgressAdditionalWeight
} from './progress-additional.ts';

describe('progress-additional helpers', () => {
  it('reads flat NA check progress distinctly', () => {
    const additional = { id: 'pg1', type: 'pg', prog_type: { ch: 'na' } } as AdditionalWithId;

    expect(readProgressAdditional(additional)).toMatchObject({
      kind: 'check',
      value: 'NA'
    });
  });

  it('writes NA through the creation helper', () => {
    const additional = createProgressAdditional({ kind: 'check', value: 'NA' });

    expect((additional as any).prog_type.ch).toBe('na');
  });

  it('does not report NA as checked', () => {
    const additional = { id: 'pg1', type: 'pg', prog_type: { ch: 'na' } } as AdditionalWithId;

    expect(getProgressAdditionalData(additional)).toEqual({ checked: false });
  });

  it('reads flat WontDo check progress distinctly', () => {
    const additional = { id: 'pg1', type: 'pg', prog_type: { ch: 'wd' } } as AdditionalWithId;

    expect(readProgressAdditional(additional)).toMatchObject({
      kind: 'check',
      value: 'WontDo'
    });
  });

  it('writes WontDo through the creation helper', () => {
    const additional = createProgressAdditional({ kind: 'check', value: 'WontDo' });

    expect((additional as any).prog_type.ch).toBe('wd');
  });

  it('does not report WontDo as checked', () => {
    const additional = { id: 'pg1', type: 'pg', prog_type: { ch: 'wd' } } as AdditionalWithId;

    expect(getProgressAdditionalData(additional)).toEqual({ checked: false });
  });
});

describe('setProgressAdditionalValue', () => {
  it('writes a check value and preserves id/weight/desc', () => {
    const additional = {
      id: 'pg1',
      type: 'pg',
      prog_type: { ch: 'f' },
      weight: 50,
      desc: 'lift'
    } as AdditionalWithId;

    const next = setProgressAdditionalValue(additional, 'Partial') as any;

    expect(next.id).toBe('pg1');
    expect(next.prog_type).toEqual({ ch: 'p' });
    expect(next.weight).toBe(50);
    expect(next.desc).toBe('lift');
    // Manual entries never carry marker fields.
    expect(next.mode).toBeUndefined();
    expect(next.computed).toBeUndefined();
  });

  it('writes a percentage value clamped through the creation helper', () => {
    const additional = {
      id: 'pg2',
      type: 'pg',
      prog_type: { pct: 0 },
      weight: 100
    } as AdditionalWithId;

    const next = setProgressAdditionalValue(additional, 42) as any;

    expect(next.prog_type).toEqual({ pct: 42 });
    expect(next.id).toBe('pg2');
  });

  it('forces a clean manual entry when called on a rollup marker', () => {
    const marker = {
      id: 'pg3',
      type: 'pg',
      mode: 'rollup',
      base_prog_type: { ch: 'f' },
      weight: 100,
      offset_base: { ch: 't' }
    } as AdditionalWithId;

    const next = setProgressAdditionalValue(marker, 'True') as any;

    // A directly-set value is always manual: marker fields are stripped.
    expect(next.prog_type).toEqual({ ch: 't' });
    expect(next.mode).toBeUndefined();
    expect(next.base_prog_type).toBeUndefined();
    expect(next.offset_base).toBeUndefined();
    expect(next.id).toBe('pg3');
  });
});

describe('setProgressAdditionalWeight', () => {
  it('updates weight on a manual entry preserving value/kind/desc/id', () => {
    const additional = {
      id: 'pg1',
      type: 'pg',
      prog_type: { pct: 30 },
      weight: 100,
      desc: 'run'
    } as AdditionalWithId;

    const next = setProgressAdditionalWeight(additional, 25) as any;

    expect(next.weight).toBe(25);
    expect(next.prog_type).toEqual({ pct: 30 });
    expect(next.desc).toBe('run');
    expect(next.id).toBe('pg1');
  });

  it('preserves offset_base on a rollup marker', () => {
    const marker = {
      id: 'pg2',
      type: 'pg',
      mode: 'rollup',
      base_prog_type: { ch: 'f' },
      weight: 100,
      offset_base: { ch: 't' }
    } as AdditionalWithId;

    const next = setProgressAdditionalWeight(marker, 10) as any;

    expect(next.weight).toBe(10);
    expect(next.mode).toBe('rollup');
    expect(next.base_prog_type).toEqual({ ch: 'f' });
    expect(next.offset_base).toEqual({ ch: 't' });
    expect(next.id).toBe('pg2');
  });

  it('falls back to default 100 for non-finite weight', () => {
    const additional = { id: 'pg1', type: 'pg', prog_type: { ch: 'f' } } as AdditionalWithId;
    const next = setProgressAdditionalWeight(additional, Number.NaN) as any;
    expect(next.weight).toBe(100);
  });
});

describe('setProgressAdditionalDesc', () => {
  it('sets a description preserving value/weight/id', () => {
    const additional = {
      id: 'pg1',
      type: 'pg',
      prog_type: { ch: 't' },
      weight: 50
    } as AdditionalWithId;

    const next = setProgressAdditionalDesc(additional, 'done') as any;

    expect(next.desc).toBe('done');
    expect(next.prog_type).toEqual({ ch: 't' });
    expect(next.weight).toBe(50);
    expect(next.id).toBe('pg1');
  });

  it('clears the description with null', () => {
    const additional = {
      id: 'pg1',
      type: 'pg',
      prog_type: { ch: 't' },
      desc: 'old'
    } as AdditionalWithId;

    const next = setProgressAdditionalDesc(additional, null) as any;

    expect(next.desc).toBeNull();
  });
});

describe('progress mutator round-trips', () => {
  it('kind + value + weight + desc compose without leaking marker fields', () => {
    let add: AdditionalWithId = createProgressAdditional({ kind: 'check', value: false });

    add = setProgressAdditionalKind(add, 'percentage') as AdditionalWithId;
    add = setProgressAdditionalValue(add, 60) as AdditionalWithId;
    add = setProgressAdditionalWeight(add, 33) as AdditionalWithId;
    add = setProgressAdditionalDesc(add, 'halfway') as AdditionalWithId;

    const shape = readProgressAdditional(add);
    expect(shape).toMatchObject({ kind: 'percentage', value: 60, weight: 33, desc: 'halfway' });
    expect((add as any).mode).toBeUndefined();
    expect((add as any).computed).toBeUndefined();
  });

  it('toggling computed back to manual seeds the value from the marker base', () => {
    let add: AdditionalWithId = createProgressAdditional({ kind: 'check', value: true });
    add = setProgressAdditionalComputed(add, true) as AdditionalWithId;
    expect((add as any).mode).toBe('rollup');
    add = setProgressAdditionalComputed(add, false) as AdditionalWithId;
    expect((add as any).prog_type).toEqual({ ch: 't' });
    expect((add as any).mode).toBeUndefined();
  });
});
