/**
 * Shared transformers.js/onnxruntime-web environment configuration. Every
 * consumer (STT, Kokoro, browser chat) reads weights only from the browser
 * model store through `offlineTransformersEnv` and runs ORT on the vendored
 * same-origin wasm pair.
 */

import { offlineTransformersEnv, type TransformersEnvFlags, type transformersCache } from '@shared-packages/model-store';

export type TransformEnv = TransformersEnvFlags & {
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
	cache: ReturnType<typeof transformersCache>
): void {
	offlineTransformersEnv(mod.env, cache);
	if (configured) return;
	configured = true;
	mod.env.backends.onnx.wasm.wasmPaths = '/vendor/ort/';
	mod.env.backends.onnx.wasm.numThreads =
		typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? 2 : 1;
	mod.env.backends.onnx.wasm.proxy = false;
}
