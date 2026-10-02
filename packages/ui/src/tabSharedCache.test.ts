import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createTabSharedCache } from './tabSharedCache.js';
import { closeIdbForTests } from './idb.js';
const name = 'cache-audit';
const make = () => createTabSharedCache<string>({ name, store: 'values', staleMs: 1000 });
afterEach(async () => {
  vi.restoreAllMocks();
  await closeIdbForTests(name);
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
  });
});
it('retains the first concurrent writer with keepExisting and reads after commit', async () => {
  const cache = make();
  const arrived = vi.fn(); const off = cache.onArrival(arrived);
  await Promise.all([cache.put('a', 'first', { keepExisting: true }), cache.put('a', 'second', { keepExisting: true })]);
  expect(await cache.get('a')).toBe('first');
  expect(arrived).toHaveBeenCalledTimes(1); off();
});
it('rejects an abort after request success without announcing the value', async () => {
  const cache = make();
  await cache.put('seed', 'ready');
  const arrived = vi.fn(); const off = cache.onArrival(arrived);
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
    const req = put.call(this, value, key);
    req.addEventListener('success', () => this.transaction.abort());
    return req;
  });
  await expect(cache.put('a', 'lost')).rejects.toThrow('aborted');
  expect(arrived).not.toHaveBeenCalled(); off();
});
it('reopens after the cached connection is closed', async () => {
  const cache = make();
  await cache.put('a', 'saved');
  await closeIdbForTests(name);
  expect(await cache.get('a')).toBe('saved');
});
