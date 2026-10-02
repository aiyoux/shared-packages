import { describe, expect, it } from 'vitest';
import { createModelStore, type ModelLock } from './store.js';
import { modelPathFromRequest, transformersCache } from './transformers.js';
import type { ModelDef } from './types.js';

function fakeOpfs() {
  const files = new Map<string, Blob>();
  let rejectManifest = false;
  function directory(prefix = ''): FileSystemDirectoryHandle {
    return {
      kind: 'directory', name: prefix.split('/').at(-1),
      async getDirectoryHandle(name: string) { return directory(prefix + name + '/'); },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const key = prefix + name;
        if (options?.create && !files.has(key)) files.set(key, new Blob([]));
        if (!options?.create && !files.has(key)) throw new DOMException('missing', 'NotFoundError');
        return {
          async getFile() {
            if (!files.has(key)) throw new DOMException('missing', 'NotFoundError');
            return new File([files.get(key)!], name);
          },
          async createWritable() {
            const chunks: BlobPart[] = [];
            return {
              async write(value: BlobPart) { chunks.push(value); },
              async close() {
                if (rejectManifest && name === 'manifest.json') throw new Error('disk full');
                files.set(key, new Blob(chunks));
              },
              async abort() {}
            };
          }
        };
      },
      async *entries() {
        const seen = new Set<string>();
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length); const name = rest.split('/')[0];
          if (!name || seen.has(name)) continue; seen.add(name);
          yield [name, { kind: rest.includes('/') ? 'directory' : 'file' }];
        }
      },
      async removeEntry(name: string, options?: { recursive?: boolean }) {
        const key = prefix + name;
        if (options?.recursive) for (const path of [...files.keys()]) { if (path.startsWith(key + '/')) files.delete(path); }
        else files.delete(key);
      }
    } as unknown as FileSystemDirectoryHandle;
  }
  return { root: async () => directory(), files, failManifest: (value = true) => { rejectManifest = value; } };
}
function queuedLock(): ModelLock {
  const tail = new Map<string, Promise<unknown>>();
  return async (id, _mode, run, signal) => {
    const previous = tail.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => { signal?.throwIfAborted(); return run(); });
    tail.set(id, pending); return pending;
  };
}
const def: ModelDef = { id: 'test:model', label: 'Test', task: 'chat', origin: { kind: 'hf', repo: 'a/b', revision: 'abc' }, files: [{ path: 'onnx/model.onnx', bytes: 3 }] };
const bytes = (value: string) => new Blob([value]).stream();
function setup() {
  const fs = fakeOpfs(); const store = createModelStore({ root: fs.root, lock: queuedLock() });
  return { fs, store };
}

describe('browser model store', () => {
  it('does not publish interrupted writes or overwrite the previous completed file', async () => {
    const { store, fs } = setup();
    await store.write(def.id, def.files[0].path, bytes('old'));
    fs.failManifest();
    await expect(store.write(def.id, def.files[0].path, bytes('new'))).rejects.toThrow('disk full');
    expect(await (await store.file(def.id, def.files[0].path)).text()).toBe('old');
    expect((await store.status(def)).ready).toBe(true);
    expect([...fs.files.keys()].filter(key => key.includes('.data/'))).toHaveLength(1);
  });
  it('recovers an interrupted first install and sweeps unpublished bytes before the next write', async () => {
    const { store, fs } = setup(); const path = def.files[0].path;
    fs.failManifest();
    await expect(store.write(def.id, path, bytes('one'))).rejects.toThrow('disk full');
    expect((await store.status(def)).present).toBe(0);
    fs.files.set(encodeURIComponent(def.id) + '/.data/orphan', new Blob(['orphan']));
    fs.failManifest(false);
    await store.write(def.id, path, bytes('one'));
    expect([...fs.files.keys()].filter(key => key.includes('.data/'))).toHaveLength(1);
    expect((await store.status(def)).ready).toBe(true);
  });
  it('rejects size/hash mismatches and cancellation before any file counts', async () => {
    const { store } = setup();
    await expect(store.write(def.id, def.files[0].path, bytes('bad'), { expectedBytes: 4 })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expect(store.write(def.id, def.files[0].path, bytes('bad'), { expectedBlake3: '0'.repeat(64) })).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    const ctl = new AbortController();
    await expect(store.write(def.id, def.files[0].path, bytes('bad'), { signal: ctl.signal, onProgress: () => ctl.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect((await store.status(def)).files[0].state).toBe('missing');
  });
  it('serialises writers and holds the model while a reader consumes its files', async () => {
    const { store } = setup(); const path = def.files[0].path;
    await Promise.all([store.write(def.id, path, bytes('one')), store.write(def.id, 'config.json', bytes('{}'))]);
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const read = store.read(def.id, async snapshot => { started(); await hold; return (await snapshot.file(path)).text(); });
    await start;
    let cleared = false;
    const clearing = store.clear(def.id, path).then(() => { cleared = true; });
    await Promise.resolve(); expect(cleared).toBe(false);
    release(); expect(await read).toBe('one'); await clearing;
    expect((await store.status(def)).ready).toBe(false);
    expect(await (await store.file(def.id, 'config.json')).text()).toBe('{}');
  });
  it('recognises corruption, stores nested paths and rejects traversal', async () => {
    const { store, fs } = setup(); const path = def.files[0].path;
    const entry = await store.write(def.id, path, bytes('one'));
    fs.files.set(encodeURIComponent(def.id) + '/' + entry.storagePath, new Blob(['two']));
    expect((await store.status(def, true)).files[0].state).toBe('hash-mismatch');
    expect(() => store.write(def.id, '../escape', bytes('x'))).toThrow('Invalid model file path');
    expect((await store.status({ ...def, files: [{ path: 'toString' }] })).files[0].state).toBe('missing');
  });
  it('matches both transformers cache URLs and returns an optional-file 404 without fetching', async () => {
    const { store } = setup();
    await store.write(def.id, 'config.json', bytes('{}'));
    const cache = transformersCache(def, store);
    expect(modelPathFromRequest('/models/a/b/config.json', def)).toBe('config.json');
    expect(await (await cache.match('https://huggingface.co/a/b/resolve/abc/config.json'))?.text()).toBe('{}');
    expect((await cache.match('/models/a/b/missing.json'))?.status).toBe(404);
    await expect(cache.put()).rejects.toThrow('Engines cannot write');
  });
});
