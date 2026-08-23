import { ENGINE_CATALOG, type CompressionEngine, type EngineId, type EngineInfo } from './types.js';

const cache = new Map<EngineId, CompressionEngine>();

export function listEngines(): readonly EngineInfo[] {
	return ENGINE_CATALOG;
}

/** Load one engine (and its library / WASM) on demand. Cached after first call. */
export async function loadEngine(id: EngineId): Promise<CompressionEngine> {
	const hit = cache.get(id);
	if (hit) return hit;

	let engine: CompressionEngine;
	if (id === 'fflate') {
		const { fflateEngine } = await import('./engines/fflate.js');
		engine = fflateEngine;
	} else if (id === 'zipkit') {
		const { zipkitEngine } = await import('./engines/zipkit.js');
		engine = zipkitEngine;
	} else if (id === 'addmaple') {
		const { addmapleEngine } = await import('./engines/addmaple.js');
		engine = addmapleEngine;
	} else if (id === 'tarjs') {
		const { tarjsEngine } = await import('./engines/tarjs.js');
		engine = tarjsEngine;
	} else if (id === 'nanotar') {
		const { nanotarEngine } = await import('./engines/nanotar.js');
		engine = nanotarEngine;
	} else {
		throw new Error(`Unknown compression engine: ${id}`);
	}

	await engine.load();
	cache.set(id, engine);
	return engine;
}

export function peekEngine(id: EngineId): CompressionEngine | null {
	return cache.get(id) ?? null;
}
