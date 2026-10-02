import { browserModelStore, type BrowserModelStore, ModelStoreError } from './store.js';
import type { ModelDef } from './types.js';

export function modelPathFromRequest(request: Request | string | URL, def: ModelDef): string | null {
  if (def.origin.kind !== 'hf') return null;
  const url = typeof request === 'string' ? request : 'url' in request ? request.url : String(request);
  const remote = `https://huggingface.co/${def.origin.repo}/resolve/`;
  if (url.startsWith(remote)) {
    const rest = url.slice(remote.length); const slash = rest.indexOf('/');
    return slash < 0 ? null : decodeURIComponent(rest.slice(slash + 1));
  }
  const local = `/models/${def.origin.repo}/`;
  const index = url.indexOf(local);
  return index < 0 ? null : decodeURIComponent(url.slice(index + local.length));
}

/** A snapshot a consumer holds under `readReady`, or the store itself. */
export type ModelFiles = { file: (path: string) => Promise<File> };

/**
 * transformers.js `customCache`. A miss must be `undefined`: any Response,
 * even a 404, counts as a hit and its body would be parsed as the file. With
 * {@link offlineTransformersEnv} a miss then resolves an optional config to
 * null and fails a required file by name; neither fetches.
 */
export function transformersCache(def: ModelDef, files: ModelFiles | BrowserModelStore = browserModelStore) {
  const source: ModelFiles = 'readReady' in files ? { file: path => files.file(def.id, path) } : files;
  return {
    async match(request: Request | string | URL): Promise<Response | undefined> {
      const path = modelPathFromRequest(request, def); if (!path) return undefined;
      try { return new Response(await source.file(path), { headers: { 'content-type': 'application/octet-stream' } }); }
      catch (error) {
        if (error instanceof ModelStoreError && error.code === 'MISSING_FILES') return undefined;
        throw error;
      }
    },
    async put(): Promise<void> { throw new Error('Engines cannot write model weights; load files in Settings → AI models.'); }
  };
}

export type TransformersEnvFlags = {
  allowLocalModels: boolean; allowRemoteModels: boolean; localModelPath: string;
  useBrowserCache: boolean; useCustomCache: boolean; customCache?: unknown;
};
/**
 * Weights come only from the store. transformers.js rejects local and remote
 * both off, so local stays on with a `blob:` root that no fetch can resolve:
 * a cache miss fails without touching the network.
 */
export function offlineTransformersEnv(env: TransformersEnvFlags, cache: ReturnType<typeof transformersCache>): void {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = 'blob:browser-models/';
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = cache;
}
