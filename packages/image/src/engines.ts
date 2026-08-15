import { ENGINE_CATALOG, type EngineId, type EngineInfo, type ImageEngine } from './types.js';

const cache = new Map<EngineId, ImageEngine>();

export function listEngines(): readonly EngineInfo[] {
	return ENGINE_CATALOG;
}

/** Load one engine (and its WASM) on demand. Cached after first call. */
export async function loadEngine(id: EngineId): Promise<ImageEngine> {
	const hit = cache.get(id);
	if (hit) return hit;

	let engine: ImageEngine;
	if (id === 'native') {
		const { nativeEngine } = await import('./engines/native.js');
		engine = nativeEngine;
	} else if (id === 'jsquash') {
		const { jsquashEngine } = await import('./engines/jsquash.js');
		engine = jsquashEngine;
	} else {
		throw new Error(`Unknown image engine: ${id}`);
	}

	await engine.load();
	cache.set(id, engine);
	return engine;
}

export function peekEngine(id: EngineId): ImageEngine | null {
	return cache.get(id) ?? null;
}
