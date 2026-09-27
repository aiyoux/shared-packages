import { hfResolveUrl, type SpeechModelDef } from './models.js';
import { SpeechEngineError } from './types.js';

/**
 * One-click model downloads through the monitor's fetch proxy
 * (`GET /v1/tools/fetch?url=`). The hub page is COEP-isolated and the file
 * hosts don't serve fetchable CORS headers, so the daemon fetches
 * server-side (host-allowlisted) and streams the bytes back. Responses drop
 * straight into `ModelStore.ingestResponse`, the same VFS ingest the manual
 * import path uses — the bridge is a transport, not a second store.
 */

/** Daemon bind from the monitor's example config; the card's default. */
export const DEFAULT_BRIDGE_BASE_URL = 'http://127.0.0.1:9847';

/** Proxy URL for one catalog file. Pure — unit-tested, no fetching. */
export function bridgeFetchUrl(
	baseUrl: string,
	def: SpeechModelDef,
	path: string
): string {
	const base = baseUrl.replace(/\/+$/, '');
	return `${base}/v1/tools/fetch?url=${encodeURIComponent(hfResolveUrl(def, path))}`;
}

/** Fetch one catalog file through the bridge; rejects with DOWNLOAD_FAILED. */
export async function fetchModelFileViaBridge(
	baseUrl: string,
	def: SpeechModelDef,
	path: string,
	opts?: { signal?: AbortSignal }
): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(bridgeFetchUrl(baseUrl, def, path), { signal: opts?.signal });
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') throw err;
		throw new SpeechEngineError(
			'DOWNLOAD_FAILED',
			`Cannot reach the model bridge at ${baseUrl}. Is the monitor running?`
		);
	}
	if (!res.ok || !res.body) {
		throw new SpeechEngineError(
			'DOWNLOAD_FAILED',
			`Bridge fetch failed for ${path}: HTTP ${res.status}`
		);
	}
	return res;
}
