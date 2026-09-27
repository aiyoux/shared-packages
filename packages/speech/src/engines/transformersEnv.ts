/**
 * Shared transformers.js/onnxruntime-web environment configuration. Both
 * consumers (transformersStt, kokoroTts) route weight fetches through the
 * VFS-backed cache and run ORT on the vendored same-origin wasm pair.
 */

export type TransformEnv = {
	allowLocalModels: boolean;
	allowRemoteModels: boolean;
	useBrowserCache: boolean;
	useCustomCache: boolean;
	customCache?: unknown;
	backends: {
		onnx: {
			wasm: { wasmPaths: string; numThreads?: number; proxy?: boolean };
		};
	};
};

let configured = false;

/**
 * Point ORT at the vendored same-origin wasm pair; threads only when the
 * page is actually cross-origin isolated (Safari ignores COEP
 * `credentialless`, so it has no SharedArrayBuffer).
 */
export function configureTransformersEnv(
	mod: { env: TransformEnv },
	cache: unknown
): void {
	mod.env.customCache = cache;
	if (configured) return;
	configured = true;
	mod.env.allowLocalModels = false;
	mod.env.allowRemoteModels = true;
	mod.env.useBrowserCache = false;
	mod.env.useCustomCache = true;
	mod.env.backends.onnx.wasm.wasmPaths = '/vendor/ort/';
	mod.env.backends.onnx.wasm.numThreads =
		typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? 2 : 1;
	mod.env.backends.onnx.wasm.proxy = false;
}