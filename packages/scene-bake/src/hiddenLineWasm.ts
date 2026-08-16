/**
 * Worker-safe helpers for the experimental hidden_line WASM occlusion path.
 *
 * Loaded primarily inside `bake.worker.ts`. Uses BASE_URL-aware asset URLs so
 * subpath deploys work (do not use bare `/wasm/...` origins).
 */

export interface HiddenLineWasmApi {
	hl_upload_mesh: (
		geometryId: number,
		position: Float32Array,
		index: Uint32Array,
		positionVersion: number,
		indexVersion: number,
	) => void;
	hl_upload_edge: (
		geometryId: number,
		position: Float32Array,
		positionVersion: number,
	) => void;
	hl_evict_mesh: (geometryId: number) => void;
	hl_evict_edge: (geometryId: number) => void;
	hl_clear_cache: () => void;
	compute_visible_spans: (requestJson: string) => Float32Array[];
	init?: () => void;
}

/** Prefix path with SvelteKit base (worker-safe — no document). */
export function wasmAssetUrl(path: string): string {
	const base = (import.meta.env.BASE_URL ?? '/').replace(/\/?$/, '/');
	const rel = path.replace(/^\//, '');
	// In workers, self.location.origin is the page origin.
	const origin =
		typeof self !== 'undefined' && self.location
			? self.location.origin
			: typeof location !== 'undefined'
				? location.origin
				: 'http://localhost';
	return new URL(base + rel, origin).href;
}

let wasmPromise: Promise<HiddenLineWasmApi | null> | null = null;
let available = false;

export function isHiddenLineWasmAvailable(): boolean {
	return available;
}

/**
 * Load the committed hidden_line artifact. Returns null on failure (no WASM,
 * load error, missing exports). Single flight; failed loads can be retried by
 * clearing wasmPromise (not exported — next session).
 */
export async function loadHiddenLineWasm(): Promise<HiddenLineWasmApi | null> {
	if (wasmPromise) return wasmPromise;

	if (typeof WebAssembly === 'undefined') {
		wasmPromise = Promise.resolve(null);
		return wasmPromise;
	}

	const p = (async (): Promise<HiddenLineWasmApi | null> => {
		try {
			const jsUrl = wasmAssetUrl('/wasm/hidden_line/sketcher_wasm.js');
			// @vite-ignore — committed static glue, not bundled into worker graph
			const mod = await import(/* @vite-ignore */ jsUrl);
			if (typeof mod.default === 'function') {
				await mod.default();
			}
			if (typeof mod.init === 'function') {
				mod.init();
			}
			const api: HiddenLineWasmApi = {
				hl_upload_mesh: mod.hl_upload_mesh,
				hl_upload_edge: mod.hl_upload_edge,
				hl_evict_mesh: mod.hl_evict_mesh,
				hl_evict_edge: mod.hl_evict_edge,
				hl_clear_cache: mod.hl_clear_cache,
				compute_visible_spans: (requestJson: string) => {
					const raw = mod.compute_visible_spans(requestJson);
					// wasm-bindgen returns a JS Array of Float32Array
					if (Array.isArray(raw)) return raw as Float32Array[];
					// Or a JS Array-like from js_sys::Array
					const out: Float32Array[] = [];
					const len = raw?.length ?? 0;
					for (let i = 0; i < len; i++) {
						const item = raw[i];
						out.push(
							item instanceof Float32Array
								? item
								: new Float32Array(item),
						);
					}
					return out;
				},
				init: mod.init,
			};
			if (
				typeof api.hl_upload_mesh !== 'function' ||
				typeof mod.compute_visible_spans !== 'function'
			) {
				throw new Error('hidden_line WASM missing required exports');
			}
			available = true;
			return api;
		} catch (err) {
			console.warn('[hiddenLineWasm] load failed:', err);
			available = false;
			return null;
		}
	})();

	wasmPromise = p.then((api) => {
		if (!api) wasmPromise = null; // allow retry after failure
		return api;
	});
	return wasmPromise;
}

/** Test-only: reset module state. */
export function resetHiddenLineWasmForTests() {
	wasmPromise = null;
	available = false;
}
