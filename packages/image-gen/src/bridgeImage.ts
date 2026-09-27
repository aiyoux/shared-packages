import { hfImageResolveUrl, type ImageModelDef } from './imageModels.js';
import { ImageGenError } from './engines.js';

/**
 * One-click image-model downloads through the monitor's fetch proxy
 * (`GET /v1/tools/fetch?url=`), mirroring the speech bridge client. The
 * daemon fetches server-side (host-allowlisted) and streams the bytes back
 * past page CORS/COEP; responses drop into `ImageStore.ingestResponse`.
 */

/** Daemon bind from the monitor's example config; the UI default. */
export const DEFAULT_IMAGE_BRIDGE_BASE_URL = 'http://127.0.0.1:9847';

/** Proxy URL for one catalog file. Pure — unit-tested, no fetching. */
export function bridgeImageFetchUrl(
	baseUrl: string,
	def: Pick<ImageModelDef, 'repo' | 'revision'>,
	path: string
): string {
	const base = baseUrl.replace(/\/+$/, '');
	return `${base}/v1/tools/fetch?url=${encodeURIComponent(hfImageResolveUrl(def, path))}`;
}

/** Fetch one catalog file through the bridge; rejects with DOWNLOAD_FAILED-shaped errors. */
export async function fetchImageFileViaBridge(
	baseUrl: string,
	def: Pick<ImageModelDef, 'repo' | 'revision'>,
	path: string,
	opts?: { signal?: AbortSignal }
): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(bridgeImageFetchUrl(baseUrl, def, path), { signal: opts?.signal });
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') throw err;
		throw new ImageGenError(
			'NO_MODEL',
			`Cannot reach the model bridge at ${baseUrl}. Is the monitor running?`
		);
	}
	if (!res.ok || !res.body) {
		throw new ImageGenError('NO_MODEL', `Bridge fetch failed for ${path}: HTTP ${res.status}`);
	}
	return res;
}
