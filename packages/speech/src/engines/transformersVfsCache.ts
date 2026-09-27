/**
 * transformers.js custom cache backed by the VFS model store (v3
 * `CacheInterface`: `match` / `put`). Weights live only in the VFS — no
 * mirrored browser Cache, no duplicated storage.
 *
 * Critical contract: `match` must return `undefined` on a miss so the library
 * fetches the file and calls `put`. A 404 Response would abort the load.
 */

import type { ModelStore } from '../modelStore.js';
import type { SpeechModelDef } from '../models.js';
import type { ModelDownloadProgress } from '../types.js';

type TransformersCache = {
	match(request: Request | string | URL): Promise<Response | undefined>;
	put(request: Request | string | URL, response: Response): Promise<void>;
};

/** `https://huggingface.co/<repo>/resolve/<rev>/<path>` → `<path>`. */
export function repoPathFromUrl(url: string, repo: string): string | null {
	const prefix = `https://huggingface.co/${repo}/resolve/`;
	if (!url.startsWith(prefix)) return null;
	const rest = url.slice(prefix.length);
	const slash = rest.indexOf('/');
	return slash >= 0 ? rest.slice(slash + 1) : null;
}

export function createVfsCache(
	store: ModelStore,
	def: SpeechModelDef,
	opts?: { onProgress?: (p: ModelDownloadProgress) => void }
): TransformersCache {
	let dirIdPromise: Promise<string> | null = null;
	const dirId = () => (dirIdPromise ??= store.modelDirId(def));

	return {
		async match(request) {
			const url = typeof request === 'string' ? request : 'url' in request ? request.url : String(request);
			const path = repoPathFromUrl(url, def.repo);
			if (!path) return undefined;
			const dir = await dirId();
			const node = await store.hasFile(dir, path);
			if (node === 'missing' || node === 'corrupt') return undefined;
			const blob = await store.readBlob(dir, path);
			return new Response(blob, {
				status: 200,
				headers: { 'Content-Type': 'application/octet-stream' }
			});
		},
		async put(request, response) {
			const url = typeof request === 'string' ? request : 'url' in request ? request.url : String(request);
			const path = repoPathFromUrl(url, def.repo);
			// Non-repo URLs (rare) still land in the model folder by basename —
			// they are re-fetchable by the library on a miss.
			if (!path) return;
			if (!response.ok || !response.body) return;
			await store.ingestResponse(def, path, response, { onProgress: opts?.onProgress });
		}
	};
}