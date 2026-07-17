import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppCache } from './store.svelte.ts';

// Regression coverage for the "remove one of two permissions -> both gone"
// bug: normalizeItem's mergeItem preserves any key whose incoming value is
// `undefined` (correct for fields that arrive in genuine partial payloads),
// but permissions is a full-array-replace field with no merge/tombstone
// path, so a legitimate transition to empty must actually overwrite the
// cache. recordCoreFromRow / normalizeLiveRecordPermissions is what decides
// whether a cleared record's `permissions` key is `[]` (overwrite) or
// `undefined` (preserve) -- see changefeed-convert.test.ts for that half.
// This file covers the cache-merge behavior those two shapes trigger.
describe('AppCache permissions merge', () => {
  let cache: ReturnType<typeof createAppCache>;

  beforeEach(() => {
    cache = createAppCache();
  });

  afterEach(() => {
    cache.clear();
  });

  it('overwrites a cached permissions array to empty when the incoming core carries []', () => {
    cache.normalizeItem({
      id: 'records:r1',
      text: 'hi',
      is_temp: false,
      dirty: false,
      sync_status: 'accepted',
      permissions: [
        { role: 'owner', user_id: 'users:a' },
        { role: 'editor', user_id: 'users:b' }
      ]
    } as any);
    expect(cache.getItem('records:r1')?.permissions).toHaveLength(2);

    cache.normalizeItem({
      id: 'records:r1',
      text: 'hi',
      is_temp: false,
      dirty: false,
      sync_status: 'accepted',
      permissions: []
    } as any);

    expect(cache.getItem('records:r1')?.permissions).toEqual([]);
  });

  it('preserves the cached permissions array when the incoming core has an undefined permissions value (partial payload)', () => {
    cache.normalizeItem({
      id: 'records:r1',
      text: 'hi',
      is_temp: false,
      dirty: false,
      sync_status: 'accepted',
      permissions: [{ role: 'owner', user_id: 'users:a' }]
    } as any);

    // recordCoreFromRow always declares the `permissions` key explicitly
    // (even when its value is `undefined`) -- mergeItem only preserves a
    // key that is present-but-undefined, not one omitted outright, so the
    // simulated partial core must match that shape.
    cache.normalizeItem({
      id: 'records:r1',
      text: 'hi edited',
      is_temp: false,
      dirty: false,
      sync_status: 'accepted',
      permissions: undefined
    } as any);

    expect(cache.getItem('records:r1')?.permissions).toEqual([{ role: 'owner', user_id: 'users:a' }]);
    expect(cache.getItem('records:r1')?.text).toBe('hi edited');
  });

  it('overwrites the survivor correctly when one of two permissions is removed', () => {
    cache.normalizeItem({
      id: 'records:r1',
      text: 'hi',
      is_temp: false,
      dirty: false,
      sync_status: 'accepted',
      permissions: [
        { role: 'owner', user_id: 'users:a', username: 'Alice' },
        { role: 'editor', user_id: 'users:b', username: 'Bob' }
      ]
    } as any);

    cache.normalizeItem({
      id: 'records:r1',
      text: 'hi',
      is_temp: false,
      dirty: false,
      sync_status: 'accepted',
      permissions: [{ role: 'owner', user_id: 'users:a', username: 'Alice' }]
    } as any);

    expect(cache.getItem('records:r1')?.permissions).toEqual([{ role: 'owner', user_id: 'users:a', username: 'Alice' }]);
  });
});
