import { createBLAKE3 } from 'hash-wasm';
import type { ModelDef, ModelManifest, ModelStatus, ModelWriteOptions, StoredModelFile } from './types.js';

const ROOT = 'browser-models';
const CHANNEL = 'browser-models:changed';
const MANIFEST = 'manifest.json';
const missing = (error: unknown) => (error as { name?: string })?.name === 'NotFoundError';

export class ModelStoreError extends Error {
  constructor(public readonly code: 'MISSING_FILES' | 'SIZE_MISMATCH' | 'HASH_MISMATCH' | 'INVALID_PATH' | 'UNAVAILABLE' | 'INVALID_MANIFEST', message: string) {
    super(message); this.name = 'ModelStoreError';
  }
}
function validPath(path: string): string[] {
  const parts = path.split('/');
  if (!path || parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[\\\x00-\x1f]/.test(part))) {
    throw new ModelStoreError('INVALID_PATH', `Invalid model file path: ${path}`);
  }
  return parts;
}
function validId(id: string): string {
  if (!id || id === '.' || id === '..' || id.length > 300 || /[\x00-\x1f]/.test(id)) throw new ModelStoreError('INVALID_PATH', 'Invalid model id');
  return encodeURIComponent(id);
}
function freshManifest(modelId: string): ModelManifest {
  return { v: 1, modelId, revision: crypto.randomUUID(), files: {} };
}
export type ModelLock = <T>(id: string, mode: 'shared' | 'exclusive', run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
const browserLock: ModelLock = async (id, mode, run, signal) => {
  if (!globalThis.navigator?.locks) throw new ModelStoreError('UNAVAILABLE', 'Model storage requires Web Locks');
  return await navigator.locks.request(`model-store:${id}`, { mode, ...(signal ? { signal } : {}) }, run);
};

/** OPFS is separate from Files. All contexts, including workers, use the same lock names. */
export function createModelStore(options: {
  root?: () => Promise<FileSystemDirectoryHandle>;
  lock?: ModelLock;
  changed?: () => void;
} = {}) {
  const lock = options.lock ?? browserLock;
  const listeners = new Set<() => void>();
  let channel: BroadcastChannel | null = null;
  function ensureChannel() {
    if (!channel && typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL);
      (channel as BroadcastChannel & { unref?: () => void }).unref?.();
      channel.onmessage = () => { for (const listener of listeners) listener(); };
    }
  }
  function changed() {
    ensureChannel();
    for (const fn of listeners) { try { fn(); } catch (error) { console.error(error); } }
    try { options.changed?.(); } catch (error) { console.error(error); }
    channel?.postMessage({ changed: true });
  }
  async function root(): Promise<FileSystemDirectoryHandle> {
    if (options.root) return options.root();
    if (!globalThis.navigator?.storage?.getDirectory) throw new ModelStoreError('UNAVAILABLE', 'Browser model storage is unavailable');
    return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
  }
  async function dir(id: string, create = false): Promise<FileSystemDirectoryHandle> {
    return (await root()).getDirectoryHandle(validId(id), { create });
  }
  async function manifest(id: string): Promise<ModelManifest> {
    try {
      const text = await (await (await dir(id)).getFileHandle(MANIFEST)).getFile().then(file => file.text());
      // A first-ever failed manifest write can leave its newly created, empty handle.
      if (!text) return freshManifest(id);
      const data = JSON.parse(text) as ModelManifest;
      if (data.v !== 1 || data.modelId !== id || typeof data.revision !== 'string' || !data.files || Array.isArray(data.files)) throw new Error('Invalid header');
      for (const [path, file] of Object.entries(data.files)) {
        validPath(path);
        if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.blake3) || !/^\.data\/[a-f0-9-]+$/.test(file.storagePath)) throw new Error('Invalid file record');
      }
      return data;
    } catch (error) {
      if (missing(error)) return freshManifest(id);
      if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith('Invalid '))) {
        throw new ModelStoreError('INVALID_MANIFEST', `The stored manifest for ${id} is unreadable`);
      }
      throw error;
    }
  }
  async function committed(id: string, data: ModelManifest): Promise<void> {
    data.revision = crypto.randomUUID();
    const file = await (await dir(id, true)).getFileHandle(MANIFEST, { create: true });
    // createWritable publishes its replacement only on close. Immutable data
    // files plus this atomic pointer swap also make a failed replace harmless.
    const stream = await file.createWritable();
    try { await stream.write(JSON.stringify(data)); await stream.close(); }
    catch (error) { await stream.abort().catch(() => {}); throw error; }
  }
  async function dataFile(id: string, stored: StoredModelFile): Promise<File> {
    const data = await (await dir(id)).getDirectoryHandle('.data');
    return (await data.getFileHandle(stored.storagePath.slice(6))).getFile();
  }
  async function discard(id: string, stored: StoredModelFile): Promise<void> {
    try {
      await (await (await dir(id)).getDirectoryHandle('.data')).removeEntry(stored.storagePath.slice(6));
    } catch (error) { if (!missing(error)) console.warn('Unused model bytes can be reclaimed on the next write', error); }
  }
  async function statusUnlocked(def: ModelDef, verify = false, signal?: AbortSignal): Promise<ModelStatus> {
    const data = await manifest(def.id);
    const files: ModelStatus['files'] = [];
    for (const file of def.files) {
      signal?.throwIfAborted();
      validPath(file.path);
      const actual = Object.hasOwn(data.files, file.path) ? data.files[file.path] : undefined;
      let state: ModelStatus['files'][number]['state'] = 'missing';
      if (actual) {
        try {
          const bytes = await dataFile(def.id, actual);
          state = bytes.size !== actual.bytes || (file.bytes != null && bytes.size !== file.bytes) ? 'size-mismatch'
            : file.blake3 && actual.blake3 !== file.blake3.toLowerCase() ? 'hash-mismatch' : 'present';
          if (verify && state === 'present') {
            const hash = await createBLAKE3(); hash.init();
            const reader = bytes.stream().getReader();
            try { while (true) { const part = await reader.read(); signal?.throwIfAborted(); if (part.done) break; hash.update(part.value); } }
            finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            if (hash.digest('hex') !== actual.blake3) state = 'hash-mismatch';
          }
        } catch (error) { if (!missing(error)) throw error; }
      }
      files.push({ ...file, state, ...(actual ? { actual } : {}) });
    }
    const present = files.filter(file => file.state === 'present').length;
    return { files, present, total: files.length, ready: Boolean(def.builtIn) || present === files.length,
      bytes: files.reduce((sum, file) => sum + (file.actual?.bytes ?? 0), 0), revision: data.revision };
  }
  const api = {
    /** Return a verified snapshot while holding the shared model lock for the entire consumer. */
    read<T>(modelId: string, run: (files: { file: (path: string) => Promise<File>; manifest: ModelManifest }) => Promise<T>, signal?: AbortSignal): Promise<T> {
      validId(modelId);
      return lock(modelId, 'shared', async () => {
        const data = await manifest(modelId);
        return run({ manifest: data, async file(path) {
          validPath(path);
          if (!Object.hasOwn(data.files, path)) throw new ModelStoreError('MISSING_FILES', `${path} is missing. Load it in Settings → AI models.`);
          return dataFile(modelId, data.files[path]);
        } });
      }, signal);
    },
    /** Check readiness under the same shared lock as the consumer, avoiding clear/replace races. */
    readReady<T>(def: ModelDef, run: (files: { file: (path: string) => Promise<File>; manifest: ModelManifest }) => Promise<T>, options: { signal?: AbortSignal; verify?: boolean } = {}): Promise<T> {
      return api.read(def.id, async files => {
        options.signal?.throwIfAborted();
        const status = await statusUnlocked(def, options.verify, options.signal);
        if (!status.ready) throw new ModelStoreError('MISSING_FILES', `${def.label}: ${status.files.filter(file => file.state !== 'present').map(file => `${file.path} (${file.state})`).join(', ')}. Load files in Settings → AI models.`);
        options.signal?.throwIfAborted();
        return run(files);
      }, options.signal);
    },
    file(modelId: string, path: string): Promise<File> { return api.read(modelId, files => files.file(path)); },
    status(def: ModelDef, verify = false): Promise<ModelStatus> {
      validId(def.id);
      return lock(def.id, 'shared', () => statusUnlocked(def, verify));
    },
    async require(def: ModelDef): Promise<ModelStatus> {
      const status = await api.status(def);
      if (!status.ready) throw new ModelStoreError('MISSING_FILES', `${def.label}: ${status.files.filter(file => file.state !== 'present').map(file => `${file.path} (${file.state})`).join(', ')}. Load files in Settings → AI models.`);
      return status;
    },
    write(modelId: string, path: string, source: ReadableStream<Uint8Array>, opts: ModelWriteOptions = {}): Promise<StoredModelFile> {
      validId(modelId); validPath(path);
      return lock(modelId, 'exclusive', async () => {
        const hash = await createBLAKE3(); hash.init();
        const model = await dir(modelId, true);
        const dataDir = await model.getDirectoryHandle('.data', { create: true });
        const before = await manifest(modelId);
        // A crashed writer can leave closed bytes that no manifest names.
        // An exclusive model lock proves no reader/writer is still using them.
        const live = new Set(Object.values(before.files).map(file => file.storagePath.slice(6)));
        const iterable = dataDir as FileSystemDirectoryHandle & { entries?: () => AsyncIterableIterator<[string, FileSystemHandle]> };
        if (iterable.entries) for await (const [unused, handle] of iterable.entries()) {
          if (handle.kind === 'file' && !live.has(unused)) await dataDir.removeEntry(unused);
        }
        const name = crypto.randomUUID();
        const target = await (await dataDir.getFileHandle(name, { create: true })).createWritable();
        const reader = source.getReader();
        const abort = () => { void reader.cancel(opts.signal?.reason).catch(() => {}); };
        opts.signal?.addEventListener('abort', abort, { once: true });
        let bytes = 0; let published = false;
        try {
          opts.signal?.throwIfAborted();
          while (true) {
            const next = await reader.read(); opts.signal?.throwIfAborted();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (opts.expectedBytes != null && bytes > opts.expectedBytes) throw new ModelStoreError('SIZE_MISMATCH', `${path} is larger than expected`);
            hash.update(next.value); await target.write(next.value as Uint8Array<ArrayBuffer>); opts.onProgress?.(bytes);
          }
          const blake3 = hash.digest('hex');
          if (opts.expectedBytes != null && bytes !== opts.expectedBytes) throw new ModelStoreError('SIZE_MISMATCH', `${path}: expected ${opts.expectedBytes} bytes, received ${bytes}`);
          if (opts.expectedBlake3 && blake3 !== opts.expectedBlake3.toLowerCase()) throw new ModelStoreError('HASH_MISMATCH', `${path} does not match the expected Blake3 hash`);
          opts.signal?.throwIfAborted(); await target.close(); opts.signal?.throwIfAborted();
          const record = { bytes, blake3, source: opts.source ?? 'This device', addedAt: Date.now(), storagePath: `.data/${name}` };
          const data = await manifest(modelId); const previous = Object.hasOwn(data.files, path) ? data.files[path] : undefined;
          Object.defineProperty(data.files, path, { value: record, enumerable: true, writable: true, configurable: true });
          await committed(modelId, data); published = true; changed();
          if (previous) await discard(modelId, previous);
          return record;
        } finally {
          opts.signal?.removeEventListener('abort', abort);
          // Cancellation and bad inputs release their source and unpublished bytes.
          await reader.cancel().catch(() => {}); reader.releaseLock();
          if (!published) { await target.abort().catch(() => {}); await dataDir.removeEntry(name).catch(() => {}); }
        }
      }, opts.signal);
    },
    clear(modelId: string, path: string): Promise<void> {
      validPath(path); validId(modelId);
      return lock(modelId, 'exclusive', async () => {
        const data = await manifest(modelId); const previous = Object.hasOwn(data.files, path) ? data.files[path] : undefined;
        if (!previous) return;
        delete data.files[path]; await committed(modelId, data); changed(); await discard(modelId, previous);
      });
    },
    clearModel(modelId: string): Promise<void> {
      validId(modelId);
      return lock(modelId, 'exclusive', async () => {
        try { await (await root()).removeEntry(validId(modelId), { recursive: true }); changed(); }
        catch (error) { if (!missing(error)) throw error; }
      });
    },
    /** Only completed manifests are advertised; orphans never become available model files. */
    async list(): Promise<ModelManifest[]> {
      const result: ModelManifest[] = [];
      const dirs = await root() as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
      for await (const [name, handle] of dirs.entries()) {
        if (handle.kind !== 'directory') continue;
        const id = decodeURIComponent(name);
        const data = await lock(id, 'shared', () => manifest(id));
        if (Object.keys(data.files).length) result.push(data);
      }
      return result;
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      ensureChannel();
      return () => { listeners.delete(fn); if (!listeners.size) { channel?.close(); channel = null; } };
    },
    estimate(): Promise<StorageEstimate> { return navigator.storage.estimate(); },
    persist(): Promise<boolean> { return navigator.storage.persist(); },
    persisted(): Promise<boolean> { return navigator.storage.persisted(); }
  };
  return api;
}
export type BrowserModelStore = ReturnType<typeof createModelStore>;
export const browserModelStore = createModelStore();
