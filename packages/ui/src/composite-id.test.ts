import { describe, expect, it } from 'vitest';
import {
  buildCompositeId,
  parseCompositeId,
  isCompositeId,
  assertCompositeId
} from './composite-id.ts';
import { COMPOSITE_SEPARATOR } from './connection-scope-select.ts';

describe('composite-id', () => {
  it('round-trips a runtimeKey + itemId', () => {
    const cId = buildCompositeId('default::user-1', 'records:abc-123');
    expect(cId).toBe(`default::user-1${COMPOSITE_SEPARATOR}records:abc-123`);
    expect(parseCompositeId(cId)).toEqual({
      runtimeKey: 'default::user-1',
      itemId: 'records:abc-123'
    });
  });

  it('splits on the FIRST separator only (itemId may contain colons)', () => {
    // runtimeKey contains `::`, itemId contains `:` — neither contains ␟.
    const cId = buildCompositeId('conn-x::user-2', 'records:uuid-with:colons');
    const parsed = parseCompositeId(cId);
    expect(parsed).not.toBeNull();
    expect(parsed!.runtimeKey).toBe('conn-x::user-2');
    expect(parsed!.itemId).toBe('records:uuid-with:colons');
  });

  it('handles temp item ids', () => {
    const cId = buildCompositeId('default::u', 'temp:abc');
    expect(parseCompositeId(cId)).toEqual({ runtimeKey: 'default::u', itemId: 'temp:abc' });
  });

  it('isCompositeId is false for a bare id (no separator)', () => {
    expect(isCompositeId('records:abc-123')).toBe(false);
    expect(isCompositeId('')).toBe(false);
  });

  it('parseCompositeId returns null for a bare id', () => {
    expect(parseCompositeId('records:abc-123')).toBeNull();
    expect(parseCompositeId('')).toBeNull();
  });

  it('two runtimes with the SAME bare item id produce DISTINCT composite ids', () => {
    const a = buildCompositeId('default::u1', 'records:collide');
    const b = buildCompositeId('conn-b::u2', 'records:collide');
    expect(a).not.toBe(b);
    // …and each parses back to its own runtimeKey while sharing the itemId.
    expect(parseCompositeId(a)!.runtimeKey).toBe('default::u1');
    expect(parseCompositeId(b)!.runtimeKey).toBe('conn-b::u2');
    expect(parseCompositeId(a)!.itemId).toBe('records:collide');
    expect(parseCompositeId(b)!.itemId).toBe('records:collide');
  });

  it('assertCompositeId throws for a bare id', () => {
    expect(() => assertCompositeId('records:abc')).toThrow();
    expect(() => assertCompositeId('')).toThrow();
  });

  it('assertCompositeId does not throw for a composite id', () => {
    expect(() => assertCompositeId(buildCompositeId('default::u', 'records:x'))).not.toThrow();
  });
});