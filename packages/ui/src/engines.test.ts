import { describe, expect, it, vi } from 'vitest';
import { createEngineRegistry } from './engines.js';

describe('lazy engine registry', () => {
  it('shares an in-flight load and forgets failed initialisation', async () => {
    const engine = {};
    const load = vi.fn(async () => engine);
    const prepare = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const registry = createEngineRegistry({ kind: 'test', catalog: ['a'], loaders: { a: load }, prepare });
    const first = registry.loadEngine('a');
    expect(registry.loadEngine('a')).toBe(first);
    expect(registry.peekEngine('a')).toBeNull();
    await expect(first).rejects.toThrow('offline');
    expect(await registry.loadEngine('a')).toBe(engine);
    expect(await registry.loadEngine('a')).toBe(engine);
    expect(load).toHaveBeenCalledTimes(2);
    expect(registry.peekEngine('a')).toBe(engine);
  });
});
