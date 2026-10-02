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
/** Missing optional config files are 404s; neither cache misses nor cache puts fetch weights. */
export function transformersCache(def: ModelDef, store: BrowserModelStore = browserModelStore) {
  return {
    async match(request: Request | string | URL): Promise<Response | undefined> {
      const path = modelPathFromRequest(request, def); if (!path) return undefined;
      try { return new Response(await store.file(def.id, path), { headers: { 'content-type': 'application/octet-stream' } }); }
      catch (error) {
        if (error instanceof ModelStoreError && error.code === 'MISSING_FILES') return new Response(null, { status: 404 });
        throw error;
      }
    },
    async put(): Promise<void> { throw new Error('Engines cannot write model weights; load files in Settings → AI models.'); }
  };
}
