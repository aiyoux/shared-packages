import { ENGINE_CATALOG, type EngineId, type EngineInfo, type VideoEngine } from './types.js';

const cache = new Map<EngineId, VideoEngine>();

export function listEngines(): readonly EngineInfo[] {
	return ENGINE_CATALOG;
}

/** Load the WebCodecs engine. Cached after first call. */
export async function loadEngine(id: EngineId): Promise<VideoEngine> {
	const hit = cache.get(id);
	if (hit) return hit;

	const { nativeEngine } = await import('./engines/native.js');
	await nativeEngine.load();
	cache.set(id, nativeEngine);
	return nativeEngine;
}

export function peekEngine(id: EngineId): VideoEngine | null {
	return cache.get(id) ?? null;
}
