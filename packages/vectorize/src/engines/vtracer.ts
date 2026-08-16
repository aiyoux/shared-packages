import type { VtracerOptions } from '../types.js';

type WasmMod = {
	vectorize_rgba: (
		data: Uint8Array,
		width: number,
		height: number,
		options: VtracerOptions
	) => string;
};

let wasm: WasmMod | null = null;

export async function loadVtracer(): Promise<void> {
	if (wasm) return;
	wasm = (await import('../wasm/vtracer_wasm.js')) as unknown as WasmMod;
}

export function vtracerReady(): boolean {
	return !!wasm;
}

export function vectorizeWithVtracer(
	rgba: Uint8Array,
	width: number,
	height: number,
	options: VtracerOptions
): string {
	if (!wasm) throw new Error('VTracer WASM is not loaded. Call loadVtracer() first.');
	return wasm.vectorize_rgba(rgba, width, height, options);
}
