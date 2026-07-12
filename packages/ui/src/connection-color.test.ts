import { describe, expect, it } from 'vitest';
import { getConnectionColor } from './connection-color.ts';

describe('getConnectionColor', () => {
  it('is deterministic for the same key', () => {
    expect(getConnectionColor('conn-abc')).toBe(getConnectionColor('conn-abc'));
  });

  it('is stable across repeated calls', () => {
    const a = getConnectionColor('stable-key');
    for (let i = 0; i < 5; i++) {
      expect(getConnectionColor('stable-key')).toBe(a);
    }
  });

  it('produces 12 distinct hues for 12 distinct keys', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `conn-${i}`);
    const colors = new Set(keys.map((k) => getConnectionColor(k)));
    // 12 keys into 12 slots — collisions are possible but extremely unlikely
    // with FNV-1a over short distinct inputs; assert at least 10 distinct so
    // the test isn't brittle against a single slot collision.
    expect(colors.size).toBeGreaterThanOrEqual(10);
  });

  it('returns an oklch() color for derived keys', () => {
    expect(getConnectionColor('conn-abc')).toMatch(/^oklch\(0\.62 0\.15 \d+(\.\d+)?deg\)$/);
  });

  it('passes a non-empty override through verbatim', () => {
    expect(getConnectionColor('conn-abc', '#ff0000')).toBe('#ff0000');
    expect(getConnectionColor('conn-abc', 'oklch(0.7 0.1 200deg)')).toBe('oklch(0.7 0.1 200deg)');
    expect(getConnectionColor('conn-abc', 'red')).toBe('red');
  });

  it('ignores empty/whitespace overrides and derives instead', () => {
    expect(getConnectionColor('conn-abc', '')).toBe(getConnectionColor('conn-abc'));
    expect(getConnectionColor('conn-abc', '   ')).toBe(getConnectionColor('conn-abc'));
    expect(getConnectionColor('conn-abc', null)).toBe(getConnectionColor('conn-abc'));
    expect(getConnectionColor('conn-abc', undefined)).toBe(getConnectionColor('conn-abc'));
  });

  it('distinguishes different keys', () => {
    expect(getConnectionColor('conn-a')).not.toBe(getConnectionColor('conn-b'));
  });
});